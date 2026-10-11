// Use the same discoverable editor routes as a person; never mutate React state.
export async function enableDragHandles(page) {
  const guide = page.locator(".scene-guide");
  if (!(await guide.evaluate((node) => node.open)))
    await guide.locator("summary").click();
  await page
    .getByRole("checkbox", { name: "Show drag handles", exact: true })
    .check();
  await guide.locator("summary").click();
}
export async function openMaterial(page, material = "Ridge") {
  await page
    .getByRole("button", { name: "Layer settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit materials", exact: true })
    .click();
  await page
    .locator(".material-tabs")
    .getByRole("button", { name: material, exact: true })
    .click();
}
export function dimensionLabel(kind) {
  return kind === "height"
    ? "Thickness"
    : kind === "pitch"
      ? "Shared pitch"
      : "Width";
}

// Preserve the original 1D fixtures while the product default is genuinely 2D.
export function legacyExampleUrl(value) {
  const url = new URL(value);
  url.searchParams.set("example", "1d");
  return url.href;
}
