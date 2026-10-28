import "dotenv/config";
import { assertCloudEnv } from "../lib/runtime-env.js";

assertCloudEnv(true);
console.log("Cloud environment is ready to start.");
