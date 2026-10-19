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
  // unknown: not typed yet.
  {
    files: [
      "src/platform/native.ts",
      "src/shared/singletonHook.ts",
      "src/types.ts",
      "src/webrtc/hooks/iceReport.ts",
      "src/webrtc/hooks/sfuTypes.ts",
      "src/webrtc/hooks/useVideoStats.ts",
      "src/webrtc/hooks/voiceLogger.ts",
    ],
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
  // @typescript-eslint/no-unused-vars: from before ESLint ran here.
  {
    files: [
      "src/audio/hooks/useDeviceEnumeration.ts",
    ],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
  // Non-null assertions from before the rule.
  {
    files: [
      "src/audio/hooks/useNativeAudioCapture.ts",
      "src/audio/hooks/useNativeScreenCapture.ts",
      "src/audio/processors/rnnoiseProcessor.ts",
      "src/audio/utils/flipVideoStream.ts",
    ],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  // Nested ternaries from before the rule.
  {
    files: [
      "src/audio/hooks/useVoiceLatency.ts",
      "src/webrtc/hooks/sfuConnectFlow.ts",
    ],
    rules: { "no-nested-ternary": "off" },
  },
  // Casts through unknown where the types don't line up yet.
  {
    files: [
      "src/audio/lib/faceFraming.ts",
      "src/platform/native.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  // Reassigned parameters from before the rule.
  {
    files: [
      "src/webrtc/hooks/selectBestSfuUrl.ts",
      "src/webrtc/hooks/sfuConnection.ts",
    ],
    rules: { "no-param-reassign": "off" },
  },
);
