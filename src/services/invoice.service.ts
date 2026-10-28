/**
 * Bilingual (EN + AR) wholesale order invoice PDF.
 * Prices and spot lock come from the immutable order record.
 */
import fs from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { db } from "../db/client.js";
import {
  orderItems,
  orders,
  products,
  users,
  type User,
} from "../db/schema.js";
import { resolvePdfFontPath } from "../lib/pdfFonts.js";
import { forbidden, notFound } from "../lib/errors.js";

import { publicDir } from "../lib/paths.js";

function money(cents: number, currency: string) {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function fmtDate(value: Date | number | string | null | undefined) {
  if (value == null) return "—";
  const d =
    value instanceof Date
      ? value
      : typeof value === "number"
        ? new Date(value < 1e12 ? value * 1000 : value)
        : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function resolveLocalImagePath(publicPath: string | null | undefined): string | null {
  if (!publicPath) return null;
  const relative = publicPath.replace(/^\/media\/?/, "");
  const full = path.join(publicDir(), relative);
  return fs.existsSync(full) ? full : null;
}

function assertOrderAccess(user: User, order: typeof orders.$inferSelect) {
  if (user.role === "admin") return;
  if (user.role === "workshop" && order.workshopId === user.id) return;
  if (user.role === "retailer" && order.retailerId === user.id) return;
  throw forbidden("No access to this order");
}

function partyLabel(u: typeof users.$inferSelect | undefined) {
  if (!u) return { en: "—", ar: "—" };
  const en = u.businessName || u.fullName;
  const ar = u.businessName || u.fullName;
  return { en, ar };
}

export async function buildOrderInvoicePdf(
  user: User,
  orderId: string,
): Promise<{ buffer: Buffer; filename: string }> {
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!order) throw notFound("Order not found");
  assertOrderAccess(user, order);

  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  const [retailer] = await db
    .select()
    .from(users)
    .where(eq(users.id, order.retailerId))
    .limit(1);
  const [workshop] = await db
    .select()
    .from(users)
    .where(eq(users.id, order.workshopId))
    .limit(1);

  const productIds = [...new Set(items.map((i) => i.productId))];
  const catalog =
    productIds.length > 0
      ? await db
          .select({ id: products.id, nameAr: products.nameAr })
          .from(products)
          .where(inArray(products.id, productIds))
      : [];
  const nameArById = new Map(catalog.map((p) => [p.id, p.nameAr]));

  const fontPath = resolvePdfFontPath();
  const doc = new PDFDocument({ margin: 48, size: "A4" });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const font = fontPath ?? "Helvetica";
  const fontBold = fontPath ?? "Helvetica-Bold";
  if (fontPath) {
    doc.registerFont("Body", fontPath);
    doc.registerFont("BodyBold", fontPath);
  }

  const use = (bold = false) => {
    doc.font(bold ? (fontPath ? "BodyBold" : fontBold) : fontPath ? "Body" : font);
  };

  const ink = "#1a2332";
  const muted = "#666666";
  const gold = "#b08d3a";

  use(true);
  doc.fontSize(20).fillColor(ink).text("Sagha — Wholesale Invoice", { align: "left" });
  use();
  doc.fontSize(11).fillColor(muted).text("صاغة — فاتورة جملة", { align: "left" });
  doc.moveDown(0.6);

  use(true);
  doc.fontSize(10).fillColor(ink).text(`Order ID / رقم الطلب: ${order.id}`);
  use();
  doc
    .fontSize(10)
    .fillColor(muted)
    .text(`Status / الحالة: ${order.status} · Payment / الدفع: ${order.paymentStatus}`);
  doc.text(`Placed / تاريخ الطلب: ${fmtDate(order.placedAt)}`);
  doc.moveDown();

  const buyer = partyLabel(retailer);
  const seller = partyLabel(workshop);

  use(true);
  doc.fontSize(12).fillColor(ink).text("Buyer / المشتري");
  use();
  doc.fontSize(10).text(buyer.en);
  if (retailer?.city || retailer?.country) {
    doc.fillColor(muted).text(
      [retailer.city, retailer.country].filter(Boolean).join(", "),
    );
  }
  if (retailer?.email) doc.fillColor(muted).text(retailer.email);
  doc.moveDown(0.5);

  use(true);
  doc.fontSize(12).fillColor(ink).text("Workshop / الورشة");
  use();
  doc.fontSize(10).text(seller.en);
  if (workshop?.city || workshop?.country) {
    doc.fillColor(muted).text(
      [workshop.city, workshop.country].filter(Boolean).join(", "),
    );
  }
  doc.moveDown();

  // Spot lock box (spot is always USD; settlement may differ)
  use(true);
  doc.fontSize(12).fillColor(gold).text("Locked gold spot / سعر الذهب المقفول");
  use();
  doc.fontSize(10).fillColor(ink);
  doc.text(
    `Fine spot / سعر العيار ٢٤: ${money(order.goldSpotPriceCentsPerGram, "USD")} / g`,
  );
  doc.text(`Locked at / وقت الإقفال: ${fmtDate(order.spotLockedAt ?? order.placedAt)}`);
  doc.text(
    `Source / المصدر: ${order.spotSource ?? "—"}` +
      (order.spotOfficial ? " (official / رسمي)" : ""),
  );
  if (order.spotRateId) {
    doc.text(`Rate ref / مرجع السعر: ${order.spotRateId}`);
  }
  doc.text(
    `Settlement / التسوية: ${order.currency}` +
      (order.currency !== "USD"
        ? ` · FX ${Number(order.fxUnitsPerUsd).toLocaleString("en-US")} ${order.currency} / 1 USD`
        : ""),
  );
  doc.moveDown();

  // Line items
  use(true);
  doc.fontSize(12).fillColor(ink).text("Line items / بنود الطلب");
  doc.moveDown(0.4);

  for (const item of items) {
    if (doc.y > 700) doc.addPage();
    const ar = nameArById.get(item.productId);
    const nameLine = ar ? `${item.productName} / ${ar}` : item.productName;
    use(true);
    doc.fontSize(10).fillColor(ink).text(nameLine, { width: 500 });
    use();
    const tierLabel =
      item.makingTierMinQty != null
        ? ` · making tier ${item.makingTierMinQty}${
            item.makingTierMaxQty != null ? `–${item.makingTierMaxQty}` : "+"
          }`
        : "";
    doc.fontSize(9).fillColor(muted).text(
      `${item.karat}K · ${Number(item.unitWeightGrams).toFixed(3)} g · qty ${item.quantity}${tierLabel}`,
    );
    doc.fontSize(9).fillColor(ink).text(
      `Gold ${money(item.lineGoldValueCents, order.currency)} + Making ${money(item.lineMakingChargeCents, order.currency)} (${money(item.unitMakingChargeCents, order.currency)}/pc) = ${money(item.lineTotalCents, order.currency)}`,
    );
    doc.moveDown(0.45);
  }

  doc
    .moveTo(48, doc.y)
    .lineTo(547, doc.y)
    .strokeColor("#dddddd")
    .stroke();
  doc.moveDown(0.6);

  use();
  doc.fontSize(10).fillColor(ink);
  doc.text(
    `Gold value / قيمة الذهب: ${money(order.goldValueCents, order.currency)}`,
    { align: "right" },
  );
  doc.text(
    `Making charges / المصنعية: ${money(order.makingChargesCents, order.currency)}`,
    { align: "right" },
  );
  use(true);
  doc.fontSize(13).fillColor(gold);
  doc.text(
    `Total / الإجمالي: ${money(order.totalCents, order.currency)}`,
    { align: "right" },
  );

  if (order.notes) {
    doc.moveDown();
    use(true);
    doc.fontSize(10).fillColor(ink).text("Notes / ملاحظات", { align: "left" });
    use();
    doc.fontSize(9).fillColor(muted).text(order.notes);
  }

  const sheetPath = resolveLocalImagePath(order.spotVerificationImagePath);
  if (sheetPath) {
    doc.moveDown();
    use(true);
    doc.fontSize(11).fillColor(ink).text("Official rate sheet / صورة نشرة السعر");
    doc.moveDown(0.3);
    try {
      doc.image(sheetPath, { fit: [480, 280], align: "center" });
    } catch {
      use();
      doc.fontSize(9).fillColor(muted).text("(Could not embed verification image)");
    }
  }

  doc.moveDown(1.5);
  use();
  doc
    .fontSize(8)
    .fillColor("#999999")
    .text(
      `Sagha B2B · Immutable spot lock · Generated ${new Date().toISOString()}`,
      { align: "center" },
    );

  doc.end();
  const buffer = await done;
  const day = fmtDate(order.placedAt).slice(0, 10);
  return {
    buffer,
    filename: `sagha-invoice-${order.id.slice(0, 8)}-${day}.pdf`,
  };
}
