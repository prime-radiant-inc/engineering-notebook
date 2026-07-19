import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolCallBlock } from "./ToolCallBlock";

describe("ToolCallBlock", () => {
  test("renders collapsed <details> with tool name + preview and the paired result inside", () => {
    render(
      <ToolCallBlock
        name="Bash"
        input={{ command: "ls -la /tmp" }}
        body={JSON.stringify({ command: "ls -la /tmp" }, null, 2)}
        result="RESULT_PAYLOAD"
      />,
    );
    // name + preview in summary
    expect(screen.getByText("Bash")).toBeInTheDocument();
    expect(screen.getByText("ls -la /tmp")).toBeInTheDocument();
    // details collapsed by default
    const details = screen.getByText("Bash").closest("details")!;
    expect(details.open).toBe(false);
    // input body + result are present in the DOM (revealed on expand)
    expect(screen.getByText(/RESULT_PAYLOAD/)).toBeInTheDocument();
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
  });

  test("omits the result section when there is no result", () => {
    render(<ToolCallBlock name="Read" input={{ file_path: "/a.ts" }} body="{}" />);
    expect(screen.getByText("/a.ts")).toBeInTheDocument();
    expect(screen.queryByText(/result/)).not.toBeInTheDocument();
  });
});
