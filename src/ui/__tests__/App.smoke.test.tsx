import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import App from "../../App";

describe("App smoke test", () => {
  it("mounts the full component tree without throwing", () => {
    const { getByRole } = render(<App />);
    expect(
      getByRole("heading", { level: 1, name: "SafeStop V2X" })
    ).toBeInTheDocument();
  });
});
