import { describe, expect, test } from "bun:test";

import { renderToStaticMarkup } from "react-dom/server";

import { ActionButton } from "./action-button";

describe("Crafter action button", () => {
  test("pending disables withdrawal and exposes its progress", () => {
    const html = renderToStaticMarkup(
      <ActionButton pending pendingLabel="Withdrawing…">
        Withdraw
      </ActionButton>,
    );
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Withdrawing…");
    expect(html).toContain('aria-label="Loading"');
  });

  test("settled actions preserve content and caller disabled state", () => {
    const enabled = renderToStaticMarkup(<ActionButton>Withdraw</ActionButton>);
    const disabled = renderToStaticMarkup(
      <ActionButton disabled>Withdraw</ActionButton>,
    );
    expect(enabled).toContain("Withdraw");
    expect(enabled).not.toContain('aria-busy="true"');
    expect(enabled).not.toContain('disabled=""');
    expect(disabled).toContain('disabled=""');
  });
});
