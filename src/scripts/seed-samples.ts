/**
 * Seed sample workshop, retailer, distinct photo catalogs per workshop.
 *   npm run seed:samples
 */
import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { initDatabase } from "../db/init.js";
import { products, users } from "../db/schema.js";
import { hashPassword } from "../lib/passwords.js";

const PASSWORD = "Sample123!";

type SeedUser = {
  email: string;
  role: "admin" | "workshop" | "retailer";
  country: "SY" | "LB";
  fullName: string;
  businessName: string | null;
  city: string | null;
  phone: string | null;
  licenseNumber: string | null;
  taxId: string | null;
  avatarPath?: string | null;
};

function seedAvatar(email: string) {
  return `https://i.pravatar.cc/300?u=${encodeURIComponent(email)}`;
}

const ACCOUNTS: SeedUser[] = [
  {
    email: "admin@sagha.local",
    role: "admin",
    country: "SY",
    fullName: "Sagha Admin",
    businessName: null,
    city: "Damascus",
    phone: null,
    licenseNumber: null,
    taxId: null,
  },
  {
    email: "workshop@sagha.local",
    role: "workshop",
    country: "SY",
    fullName: "Ahmad Al-Goldsmith",
    businessName: "Damascus Gold Workshop",
    city: "Damascus",
    phone: "+963991000001",
    licenseNumber: "WS-DM-1001",
    taxId: "TAX-WS-1001",
    avatarPath: seedAvatar("workshop@sagha.local"),
  },
  {
    email: "workshop2@sagha.local",
    role: "workshop",
    country: "SY",
    fullName: "Yara Jewelry Co.",
    businessName: "Aleppo Heritage Workshop",
    city: "Aleppo",
    phone: "+963991000002",
    licenseNumber: "WS-AL-2002",
    taxId: "TAX-WS-2002",
    avatarPath: seedAvatar("workshop2@sagha.local"),
  },
  {
    email: "workshop3@sagha.local",
    role: "workshop",
    country: "LB",
    fullName: "Karim Beirut Atelier",
    businessName: "Beirut Gold Atelier",
    city: "Beirut",
    phone: "+961711000001",
    licenseNumber: "WS-LB-3001",
    taxId: "TAX-WS-LB-3001",
    avatarPath: seedAvatar("workshop3@sagha.local"),
  },
  {
    email: "workshop4@sagha.local",
    role: "workshop",
    country: "LB",
    fullName: "Nadia Tripoli Crafts",
    businessName: "Tripoli Craft Workshop",
    city: "Tripoli",
    phone: "+961711000002",
    licenseNumber: "WS-LB-3002",
    taxId: "TAX-WS-LB-3002",
    avatarPath: seedAvatar("workshop4@sagha.local"),
  },
  {
    email: "retailer@sagha.local",
    role: "retailer",
    country: "SY",
    fullName: "Sara Retail",
    businessName: "Hamidiyeh Gold Shop",
    city: "Damascus",
    phone: "+963991000011",
    licenseNumber: "RT-DM-3001",
    taxId: "TAX-RT-3001",
    avatarPath: seedAvatar("retailer@sagha.local"),
  },
  {
    email: "retailer2@sagha.local",
    role: "retailer",
    country: "SY",
    fullName: "Omar Boutique",
    businessName: "Souq Gold Boutique",
    city: "Homs",
    phone: "+963991000012",
    licenseNumber: "RT-HO-3002",
    taxId: "TAX-RT-3002",
    avatarPath: seedAvatar("retailer2@sagha.local"),
  },
  {
    email: "retailer3@sagha.local",
    role: "retailer",
    country: "LB",
    fullName: "Verdun Jewelry Shop",
    businessName: "Verdun Jewelry Shop",
    city: "Beirut",
    phone: "+961711000011",
    licenseNumber: null,
    taxId: null,
    avatarPath: seedAvatar("retailer3@sagha.local"),
  },
  {
    email: "retailer4@sagha.local",
    role: "retailer",
    country: "LB",
    fullName: "Sidon Gold House",
    businessName: "Sidon Gold House",
    city: "Sidon",
    phone: "+961711000012",
    licenseNumber: null,
    taxId: null,
    avatarPath: seedAvatar("retailer4@sagha.local"),
  },
];

type SampleProduct = {
  name: string;
  nameAr: string;
  sku: string;
  category:
    | "rings"
    | "chains"
    | "earrings"
    | "bracelets"
    | "necklaces"
    | "bangles"
    | "pendants"
    | "sets";
  karat: 18 | 21;
  weightGrams: string;
  makingChargeCents: number;
  stockQty: number;
  imagePath: string;
  description: string;
  descriptionAr: string;
};

/** Damascus Gold Workshop — classic Damascene pieces */
const DAMASCUS_CATALOG: SampleProduct[] = [
  {
    name: "Damascus 21K Plain Band",
    nameAr: "خاتم دمشق سادة عيار ٢١",
    sku: "DM-RING-21",
    category: "rings",
    karat: 21,
    weightGrams: "4.250",
    makingChargeCents: 1200,
    stockQty: 25,
    imagePath: "/media/products/dm-ring.jpg",
    description: "Classic polished band from Damascus workshop",
    descriptionAr: "خاتم مصقول كلاسيكي من ورشة دمشق",
  },
  {
    name: "Damascus 21K Rope Chain",
    nameAr: "سلسلة حبل دمشق عيار ٢١",
    sku: "DM-CHAIN-21",
    category: "chains",
    karat: 21,
    weightGrams: "12.500",
    makingChargeCents: 3500,
    stockQty: 10,
    imagePath: "/media/products/dm-chain.jpg",
    description: "Medium rope chain, Hamidiyeh style",
    descriptionAr: "سلسلة حبل متوسطة بأسلوب الحميدية",
  },
  {
    name: "Damascus 18K Drop Earrings",
    nameAr: "أقراط متدلية دمشق عيار ١٨",
    sku: "DM-EAR-18",
    category: "earrings",
    karat: 18,
    weightGrams: "3.100",
    makingChargeCents: 1800,
    stockQty: 18,
    imagePath: "/media/products/dm-earrings.jpg",
    description: "Lightweight drop pair for retail shelves",
    descriptionAr: "زوج أقراط خفيف مناسب لرفوف التجزئة",
  },
  {
    name: "Damascus 18K Link Bracelet",
    nameAr: "سوار حلقات دمشق عيار ١٨",
    sku: "DM-BRA-18",
    category: "bracelets",
    karat: 18,
    weightGrams: "8.750",
    makingChargeCents: 2800,
    stockQty: 8,
    imagePath: "/media/products/dm-bracelet.jpg",
    description: "Solid link bracelet with secure clasp",
    descriptionAr: "سوار حلقات متين بقفل آمن",
  },
  {
    name: "Damascus 21K Layered Necklace",
    nameAr: "قلادة متعددة الطبقات دمشق عيار ٢١",
    sku: "DM-NEC-21",
    category: "necklaces",
    karat: 21,
    weightGrams: "15.200",
    makingChargeCents: 4200,
    stockQty: 6,
    imagePath: "/media/products/dm-necklace.jpg",
    description: "Layered statement necklace",
    descriptionAr: "قلادة بارزة متعددة الطبقات",
  },
  {
    name: "Damascus 21K Open Bangle",
    nameAr: "غويشة مفتوحة دمشق عيار ٢١",
    sku: "DM-BAN-21",
    category: "bangles",
    karat: 21,
    weightGrams: "18.000",
    makingChargeCents: 3000,
    stockQty: 12,
    imagePath: "/media/products/dm-bangle.jpg",
    description: "Traditional open bangle",
    descriptionAr: "غويشة مفتوحة تقليدية",
  },
  {
    name: "Damascus 18K Heart Pendant",
    nameAr: "دلاية قلب دمشق عيار ١٨",
    sku: "DM-PEN-18",
    category: "pendants",
    karat: 18,
    weightGrams: "2.400",
    makingChargeCents: 1500,
    stockQty: 30,
    imagePath: "/media/products/dm-pendant.jpg",
    description: "Heart pendant, chain sold separately",
    descriptionAr: "دلاية قلب — السلسلة تُباع منفصلة",
  },
  {
    name: "Damascus 21K Bridal Set",
    nameAr: "طقم عروس دمشق عيار ٢١",
    sku: "DM-SET-21",
    category: "sets",
    karat: 21,
    weightGrams: "28.500",
    makingChargeCents: 8500,
    stockQty: 4,
    imagePath: "/media/products/dm-set.jpg",
    description: "Necklace + earrings bridal wholesale set",
    descriptionAr: "طقم عروس جملة: قلادة وأقراط",
  },
];

/** Aleppo Heritage Workshop — heritage / ornate pieces */
const ALEPPO_CATALOG: SampleProduct[] = [
  {
    name: "Aleppo 21K Engraved Signet",
    nameAr: "خاتم ختم محفور حلب عيار ٢١",
    sku: "AL-RING-21",
    category: "rings",
    karat: 21,
    weightGrams: "5.800",
    makingChargeCents: 2100,
    stockQty: 14,
    imagePath: "/media/products/al-ring.jpg",
    description: "Heritage engraved signet ring",
    descriptionAr: "خاتم ختم تراثي محفور",
  },
  {
    name: "Aleppo 18K Cubano Chain",
    nameAr: "سلسلة كوبانو حلب عيار ١٨",
    sku: "AL-CHAIN-18",
    category: "chains",
    karat: 18,
    weightGrams: "22.000",
    makingChargeCents: 4800,
    stockQty: 7,
    imagePath: "/media/products/al-chain.jpg",
    description: "Heavy cubano wholesale chain",
    descriptionAr: "سلسلة كوبانو ثقيلة للجملة",
  },
  {
    name: "Aleppo 21K Filigree Earrings",
    nameAr: "أقراط فليغري حلب عيار ٢١",
    sku: "AL-EAR-21",
    category: "earrings",
    karat: 21,
    weightGrams: "4.600",
    makingChargeCents: 2600,
    stockQty: 11,
    imagePath: "/media/products/al-earrings.jpg",
    description: "Hand filigree earrings, Aleppo craft",
    descriptionAr: "أقراط فليغري يدوية — حرفية حلبية",
  },
  {
    name: "Aleppo 21K Cuff Bracelet",
    nameAr: "سوار كف حلب عيار ٢١",
    sku: "AL-BRA-21",
    category: "bracelets",
    karat: 21,
    weightGrams: "14.300",
    makingChargeCents: 3900,
    stockQty: 5,
    imagePath: "/media/products/al-bracelet.jpg",
    description: "Wide cuff bracelet with heritage motif",
    descriptionAr: "سوار كف عريض بزخرفة تراثية",
  },
  {
    name: "Aleppo 18K Coin Necklace",
    nameAr: "قلادة عملات حلب عيار ١٨",
    sku: "AL-NEC-18",
    category: "necklaces",
    karat: 18,
    weightGrams: "11.750",
    makingChargeCents: 3200,
    stockQty: 9,
    imagePath: "/media/products/al-necklace.jpg",
    description: "Coin-style necklace for boutiques",
    descriptionAr: "قلادة على شكل عملات للمحلات",
  },
  {
    name: "Aleppo 18K Twin Bangles",
    nameAr: "غويشتان توأم حلب عيار ١٨",
    sku: "AL-BAN-18",
    category: "bangles",
    karat: 18,
    weightGrams: "16.400",
    makingChargeCents: 2700,
    stockQty: 10,
    imagePath: "/media/products/al-bangle.jpg",
    description: "Pair of slim twin bangles (sold as set of 2)",
    descriptionAr: "زوج غويشات رفيعة (يُباع كطقم من اثنتين)",
  },
  {
    name: "Aleppo 21K Crescent Pendant",
    nameAr: "دلاية هلال حلب عيار ٢١",
    sku: "AL-PEN-21",
    category: "pendants",
    karat: 21,
    weightGrams: "3.200",
    makingChargeCents: 1900,
    stockQty: 20,
    imagePath: "/media/products/al-pendant.jpg",
    description: "Crescent pendant with fine polish",
    descriptionAr: "دلاية هلال بلمعة ناعمة",
  },
  {
    name: "Aleppo 18K Evening Set",
    nameAr: "طقم سهرة حلب عيار ١٨",
    sku: "AL-SET-18",
    category: "sets",
    karat: 18,
    weightGrams: "24.800",
    makingChargeCents: 7200,
    stockQty: 3,
    imagePath: "/media/products/al-set.jpg",
    description: "Evening necklace + earring matching set",
    descriptionAr: "طقم سهرة متناسق: قلادة وأقراط",
  },
];

/** Beirut Gold Atelier — modern Beirut wholesale pieces */
const BEIRUT_CATALOG: SampleProduct[] = [
  {
    name: "Beirut 21K Slim Band",
    nameAr: "خاتم بيروت رفيع عيار ٢١",
    sku: "BR-RING-21",
    category: "rings",
    karat: 21,
    weightGrams: "3.800",
    makingChargeCents: 1100,
    stockQty: 22,
    imagePath: "/media/products/dm-ring.jpg",
    description: "Slim polished band from Beirut atelier",
    descriptionAr: "خاتم رفيع مصقول من ورشة بيروت",
  },
  {
    name: "Beirut 18K Figaro Chain",
    nameAr: "سلسلة فيجارو بيروت عيار ١٨",
    sku: "BR-CHAIN-18",
    category: "chains",
    karat: 18,
    weightGrams: "14.200",
    makingChargeCents: 3800,
    stockQty: 9,
    imagePath: "/media/products/dm-chain.jpg",
    description: "Classic figaro chain for Verdun boutiques",
    descriptionAr: "سلسلة فيجارو كلاسيكية لمحلات الفردان",
  },
  {
    name: "Beirut 21K Hoop Earrings",
    nameAr: "أقراط حلق بيروت عيار ٢١",
    sku: "BR-EAR-21",
    category: "earrings",
    karat: 21,
    weightGrams: "3.600",
    makingChargeCents: 1700,
    stockQty: 16,
    imagePath: "/media/products/dm-earrings.jpg",
    description: "Medium hoop pair, Beirut wholesale",
    descriptionAr: "زوج أقراط حلق متوسط للجملة في بيروت",
  },
  {
    name: "Beirut 18K Tennis Bracelet",
    nameAr: "سوار تنس بيروت عيار ١٨",
    sku: "BR-BRA-18",
    category: "bracelets",
    karat: 18,
    weightGrams: "9.400",
    makingChargeCents: 3100,
    stockQty: 7,
    imagePath: "/media/products/dm-bracelet.jpg",
    description: "Tennis-style link bracelet",
    descriptionAr: "سوار حلقات بأسلوب التنس",
  },
  {
    name: "Beirut 21K Lariat Necklace",
    nameAr: "قلادة لariat بيروت عيار ٢١",
    sku: "BR-NEC-21",
    category: "necklaces",
    karat: 21,
    weightGrams: "13.800",
    makingChargeCents: 4000,
    stockQty: 5,
    imagePath: "/media/products/dm-necklace.jpg",
    description: "Adjustable lariat necklace",
    descriptionAr: "قلادة lariat قابلة للتعديل",
  },
  {
    name: "Beirut 21K Cuff Bangle",
    nameAr: "غويشة كف بيروت عيار ٢١",
    sku: "BR-BAN-21",
    category: "bangles",
    karat: 21,
    weightGrams: "17.500",
    makingChargeCents: 2900,
    stockQty: 11,
    imagePath: "/media/products/dm-bangle.jpg",
    description: "Open cuff bangle with mirror polish",
    descriptionAr: "غويشة كف مفتوحة بلمعة مرآة",
  },
  {
    name: "Beirut 18K Star Pendant",
    nameAr: "دلاية نجمة بيروت عيار ١٨",
    sku: "BR-PEN-18",
    category: "pendants",
    karat: 18,
    weightGrams: "2.100",
    makingChargeCents: 1400,
    stockQty: 28,
    imagePath: "/media/products/dm-pendant.jpg",
    description: "Star pendant for chain pairing",
    descriptionAr: "دلاية نجمة للاقتران مع السلسلة",
  },
];

/** Tripoli Craft Workshop — Mamluk-inspired northern Lebanon pieces */
const TRIPOLI_CATALOG: SampleProduct[] = [
  {
    name: "Tripoli 21K Geometric Ring",
    nameAr: "خاتم هندسي طرابلس عيار ٢١",
    sku: "TR-RING-21",
    category: "rings",
    karat: 21,
    weightGrams: "5.200",
    makingChargeCents: 2000,
    stockQty: 13,
    imagePath: "/media/products/al-ring.jpg",
    description: "Geometric motif ring, Tripoli craft",
    descriptionAr: "خاتم بزخرفة هندسية — حرفية طرابلس",
  },
  {
    name: "Tripoli 18K Box Chain",
    nameAr: "سلسلة صندوق طرابلس عيار ١٨",
    sku: "TR-CHAIN-18",
    category: "chains",
    karat: 18,
    weightGrams: "19.500",
    makingChargeCents: 4500,
    stockQty: 8,
    imagePath: "/media/products/al-chain.jpg",
    description: "Heavy box chain for wholesale",
    descriptionAr: "سلسلة صندوق ثقيلة للجملة",
  },
  {
    name: "Tripoli 21K Chandelier Earrings",
    nameAr: "أقراط ثريا طرابلس عيار ٢١",
    sku: "TR-EAR-21",
    category: "earrings",
    karat: 21,
    weightGrams: "5.100",
    makingChargeCents: 2800,
    stockQty: 10,
    imagePath: "/media/products/al-earrings.jpg",
    description: "Chandelier earrings with northern motifs",
    descriptionAr: "أقراط ثريا بزخارف شمالية",
  },
  {
    name: "Tripoli 21K Mesh Bracelet",
    nameAr: "سوار شبك طرابلس عيار ٢١",
    sku: "TR-BRA-21",
    category: "bracelets",
    karat: 21,
    weightGrams: "12.900",
    makingChargeCents: 3600,
    stockQty: 6,
    imagePath: "/media/products/al-bracelet.jpg",
    description: "Flexible mesh bracelet",
    descriptionAr: "سوار شبك مرن",
  },
  {
    name: "Tripoli 18K Medallion Necklace",
    nameAr: "قلادة ميدالية طرابلس عيار ١٨",
    sku: "TR-NEC-18",
    category: "necklaces",
    karat: 18,
    weightGrams: "10.600",
    makingChargeCents: 3300,
    stockQty: 8,
    imagePath: "/media/products/al-necklace.jpg",
    description: "Medallion necklace for display cases",
    descriptionAr: "قلادة ميدالية لواجهات العرض",
  },
  {
    name: "Tripoli 18K Stack Bangles",
    nameAr: "غويشات مكدسة طرابلس عيار ١٨",
    sku: "TR-BAN-18",
    category: "bangles",
    karat: 18,
    weightGrams: "15.700",
    makingChargeCents: 2600,
    stockQty: 9,
    imagePath: "/media/products/al-bangle.jpg",
    description: "Set of three thin stack bangles",
    descriptionAr: "طقم من ثلاث غويشات رفيعة للتكديس",
  },
  {
    name: "Tripoli 21K Olive Pendant",
    nameAr: "دلاية زيتون طرابلس عيار ٢١",
    sku: "TR-PEN-21",
    category: "pendants",
    karat: 21,
    weightGrams: "2.900",
    makingChargeCents: 1800,
    stockQty: 18,
    imagePath: "/media/products/al-pendant.jpg",
    description: "Olive branch pendant, Tripoli heritage",
    descriptionAr: "دلاية غصن زيتون — تراث طرابلس",
  },
  {
    name: "Tripoli 18K Heritage Set",
    nameAr: "طقم تراث طرابلس عيار ١٨",
    sku: "TR-SET-18",
    category: "sets",
    karat: 18,
    weightGrams: "26.200",
    makingChargeCents: 7800,
    stockQty: 4,
    imagePath: "/media/products/al-set.jpg",
    description: "Necklace and earrings heritage matching set",
    descriptionAr: "طقم متناسق تراثي: قلادة وأقراط",
  },
];

const WORKSHOP_EMAILS = [
  "workshop@sagha.local",
  "workshop2@sagha.local",
  "workshop3@sagha.local",
  "workshop4@sagha.local",
] as const;

const CATALOG_BY_EMAIL: Record<string, SampleProduct[]> = {
  "workshop@sagha.local": DAMASCUS_CATALOG,
  "workshop2@sagha.local": ALEPPO_CATALOG,
  "workshop3@sagha.local": BEIRUT_CATALOG,
  "workshop4@sagha.local": TRIPOLI_CATALOG,
};

async function upsertUser(account: SeedUser, passwordHash: string) {
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, account.email))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(users)
      .set({
        passwordHash,
        role: account.role,
        country: account.country,
        fullName: account.fullName,
        businessName: account.businessName,
        city: account.city,
        phone: account.phone,
        licenseNumber: account.licenseNumber,
        taxId: account.taxId,
        avatarPath:
          account.role === "admin"
            ? null
            : (account.avatarPath ?? seedAvatar(account.email)),
        verificationStatus: "verified",
        verifiedAt: existing.verifiedAt ?? new Date(),
        isActive: true,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return { user: updated, created: false };
  }

  const [created] = await db
    .insert(users)
    .values({
      email: account.email,
      passwordHash,
      role: account.role,
      country: account.country,
      fullName: account.fullName,
      businessName: account.businessName,
      city: account.city,
      phone: account.phone,
      licenseNumber: account.licenseNumber,
      taxId: account.taxId,
      avatarPath:
        account.role === "admin"
          ? null
          : (account.avatarPath ?? seedAvatar(account.email)),
      verificationStatus: "verified",
      verifiedAt: new Date(),
      isActive: true,
    })
    .returning();

  return { user: created, created: true };
}

async function replaceCatalog(workshopId: string, catalog: SampleProduct[]) {
  await db.delete(products).where(eq(products.workshopId, workshopId));

  for (const sample of catalog) {
    await db.insert(products).values({
      workshopId,
      name: sample.name,
      nameAr: sample.nameAr,
      description: sample.description,
      descriptionAr: sample.descriptionAr,
      sku: sample.sku,
      category: sample.category,
      karat: sample.karat,
      weightGrams: sample.weightGrams,
      makingChargeCents: sample.makingChargeCents,
      currency: "USD",
      stockQty: sample.stockQty,
      imagePath: sample.imagePath,
      status: "active",
    });
  }

  return catalog.length;
}

async function main() {
  await initDatabase();
  const passwordHash = await hashPassword(PASSWORD);

  console.log("Seeding distinct workshop catalogs…\n");

  for (const account of ACCOUNTS) {
    const { created } = await upsertUser(account, passwordHash);
    console.log(
      `${created ? "CREATED" : "UPDATED"}  ${account.role.padEnd(9)}  ${account.email}`,
    );
  }

  const workshops = await db
    .select()
    .from(users)
    .where(inArray(users.email, [...WORKSHOP_EMAILS]));

  for (const ws of workshops) {
    const catalog = CATALOG_BY_EMAIL[ws.email];
    if (!catalog) continue;
    const count = await replaceCatalog(ws.id, catalog);
    const photoSet = catalog[0].imagePath.includes("/dm-") ? "dm-*" : "al-*";
    console.log(
      `${ws.businessName}: ${count} unique products (photos: ${photoSet})`,
    );
  }

  console.log("\nDamascus / Beirut photos: /media/products/dm-*.jpg");
  console.log("Aleppo / Tripoli photos:   /media/products/al-*.jpg");
  console.log("\n--- Login (password for all) ---");
  console.log(`Password: ${PASSWORD}\n`);
  for (const a of ACCOUNTS) {
    console.log(
      `  ${a.role.padEnd(9)}  ${a.email}  ·  ${a.businessName ?? a.fullName}`,
    );
  }
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
