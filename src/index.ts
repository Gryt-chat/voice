/**
 * @gryt/voice
 *
 * Gryt's voice engine: signalling, ICE, tracks, capture, the audio graph and
 * the connection state machine. `types.ts` has the seams for the things it
 * cannot know for itself.
 *
 * `VoiceSingletonHooks` has to be mounted above anything that consumes a hook
 * from here. Without it every hook returns its initial value forever and
 * nothing says so.
 */
import { setDefaultVoicePlatform } from "./platform/index.js";
import { webPlatform } from "./platform/web.js";

/**
 * This entry point is the browser's, so it says so on the way in.
 *
 * A side effect in a barrel is worth being uncomfortable about, so: the
 * alternative is a default baked into the registry, and that puts the web
 * implementation in every bundle including React Native's, where it drags in
 * the RNNoise worker and the build fails. `setDefault` rather than `set`, so an
 * embedder that has already chosen keeps its choice no matter which module the
 * bundler evaluates first.
 */
setDefaultVoicePlatform(webPlatform);

export { webPlatform };
export * from "./engine.js";
