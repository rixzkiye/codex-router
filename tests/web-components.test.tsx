// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Button, Modal, StatusBadge } from "../web/src/components";

describe("Web Console components", () => {
  it("keeps visible status labels paired with their icon", () => {
    render(<StatusBadge status="needs_attention" />);
    expect(screen.getByText("Needs attention")).toBeVisible();
  });

  it("traps modal intent, closes with Escape, and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    const trigger = screen.getByRole("button", { name: "Open confirmation" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Confirm cancellation" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

function ModalHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open confirmation</Button>
      <Modal
        open={open}
        title="Confirm cancellation"
        description="Cancellation remains pending until terminal confirmation."
        onClose={() => setOpen(false)}
        footer={<Button onClick={() => setOpen(false)}>Close</Button>}
      >
        <p>Request interruption of the current turn.</p>
      </Modal>
    </>
  );
}
