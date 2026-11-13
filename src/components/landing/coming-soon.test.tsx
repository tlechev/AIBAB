import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import bg from "../../../messages/bg.json";
import { ComingSoon } from "./coming-soon";

describe("ComingSoon", () => {
  it("renders the Bulgarian copy with a single h1", () => {
    render(<ComingSoon {...bg.Home} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(bg.Home.title);
    expect(screen.getByText(bg.Home.subtitle)).toBeInTheDocument();
    expect(screen.getByText(bg.Home.badge)).toBeInTheDocument();
  });
});
