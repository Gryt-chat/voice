import { setDefaultVoicePlatform } from "./platform/index.js";
import { webPlatform } from "./platform/web.js";

/* Registers the web platform, so importing this package is enough. */
setDefaultVoicePlatform(webPlatform);

export { webPlatform };
export * from "./engine.js";
