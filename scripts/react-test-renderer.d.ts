// The part of react-test-renderer the engine harness uses. It ships no types of its own.
declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export interface ReactTestRenderer {
    update(element: ReactElement): void;
    unmount(): void;
  }

  const TestRenderer: {
    create(element: ReactElement, options?: { unstable_isConcurrent?: boolean }): ReactTestRenderer;
  };
  export default TestRenderer;
}
