// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "**/*.js", "**/*.mjs", "**/*.cjs", "*.tgz"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  // The SDK ships React hooks; the same rules the client and ui run.
  { files: ["**/*.{ts,tsx}"], plugins: { "react-hooks": reactHooks }, rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" } },
  // Our own values get real types; existing debt is listed below, the goal is to empty it (GRYT-1792).
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-restricted-types": ["error", { types: { unknown: "Type it. If it's outside input being checked, list the file in the config with the reason." } }],
      "no-restricted-syntax": ["error", {
        selector: "TSAsExpression > TSAsExpression.expression[typeAnnotation.type='TSUnknownKeyword']",
        message: "Don't cast through unknown. Fix the types, or disable this line with the reason.",
      }],
      "no-nested-ternary": "error",
      eqeqeq: ["error", "smart"],
      "no-else-return": "error",
      "prefer-const": "error",
      "no-param-reassign": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports", disallowTypeAnnotations: false }],
    },
  },
  // unknown: caught errors are unknown until checked.
  {
    files: [
      "src/audio/hooks/microphoneRequest.ts",
      "src/audio/hooks/useCamera.ts",
      "src/audio/lib/faceFraming.ts",
      "src/webrtc/hooks/useSFU.ts",
      "src/webrtc/hooks/videoSender.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // unknown: messages from workers and other windows arrive unchecked.
  {
    files: [
      "src/audio/hooks/useMicrophone.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // unknown: log details, browser stats and the SFU's opaque join token, all loose on purpose.
  {
    files: [
      "src/shared/singletonHook.ts",
      "src/types.ts",
      "src/webrtc/hooks/iceReport.ts",
      "src/webrtc/hooks/sfuTypes.ts",
      "src/webrtc/hooks/useVideoStats.ts",
      "src/webrtc/hooks/voiceLogger.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // unknown: only inside casts to react-native-webrtc's types.
  {
    files: ["src/platform/native.ts"],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // unknown: socket payloads arrive unchecked and are validated there.
  {
    files: [
      "src/webrtc/hooks/sfuConnection.ts",
      "src/webrtc/hooks/videoDemand.ts",
    ],
    rules: { "@typescript-eslint/no-restricted-types": "off" },
  },
  // A library's types differ from the DOM ones the SDK speaks: react-native-webrtc's, and MediaPipe's detector.
  {
    files: [
      "src/audio/lib/faceFraming.ts",
      "src/platform/native.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
);
