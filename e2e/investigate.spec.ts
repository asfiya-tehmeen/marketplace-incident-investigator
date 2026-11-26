import { expect, test, type Page } from "@playwright/test";

const shot = (name: string) => `test-results/screens/${test.info().project.name}-${name}.png`;

async function startInvestigation(page: Page, world: string, task?: string) {
  await page.goto("/");
  await page.getByRole("radio", { name: world }).check();
  if (task) await page.getByLabel("What did you notice?").fill(task);
  await page.getByRole("button", { name: "Start investigation" }).click();
  await page.waitForURL(/\/investigations\//);
}

test("flag incident: evidence → rejected red herring → human approval → flag off → undo", async ({ page }) => {
  await startInvestigation(page, "iOS leads collapse");
  await expect(page.getByText("Completed")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "A feature-flag change broke part of the funnel" })).toBeVisible();
  // The release a day earlier is considered and refuted.
  await expect(page.getByRole("complementary", { name: "Hypotheses" }).getByText("REFUTED").first()).toBeVisible();
  await page.screenshot({ path: shot("01-report"), fullPage: true });

  // Citations jump to evidence.
  await page.getByRole("button", { name: "Show evidence E1" }).first().click();
  await expect(page.locator("#ev-E1")).toBeInViewport();

  // Nothing runs without a name.
  const approve = page.getByRole("button", { name: "Approve & run" });
  await expect(approve).toBeDisabled();
  await page.getByLabel("Your name").fill("On-call lead");
  await approve.click();
  await expect(page.getByText(/Executed by On-call lead/)).toBeVisible();
  await page.screenshot({ path: shot("02-approved"), fullPage: true });

  await page.goto("/flags");
  const row = page.getByRole("row", { name: /ios-contact-flag contact_sheet_v2/ });
  await expect(row.getByText("Off")).toBeVisible();
  await expect(page.getByText("approve and execute").first()).toBeVisible();
  await page.screenshot({ path: shot("03-flags"), fullPage: true });

  await page.goBack();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(/^Undone/)).toBeVisible();
  await page.goto("/flags");
  await expect(page.getByRole("row", { name: /ios-contact-flag contact_sheet_v2/ }).getByText("On")).toBeVisible();
});

test("prompt injection in listing text is shown as data and does not produce a rollback", async ({ page }) => {
  await startInvestigation(page, "Business Bay supply drop + prompt injection");
  await expect(page.getByText("Completed")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /Fewer active listings/ })).toBeVisible();
  await expect(page.getByText("Untrusted listing text: shown as data, never followed as instructions")).toBeVisible();
  await expect(page.getByText(/Disable feature flag/)).toHaveCount(0);
  await expect(page.getByText(/Open a ticket for the supply team/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: shot("04-injection"), fullPage: true });
});

test("vague task asks for more information instead of guessing", async ({ page }) => {
  await startInvestigation(page, "Nothing is wrong", "Something feels off with the marketplace");
  await expect(page.getByText("The agent needs more information before investigating")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Which metric changed/)).toBeVisible();
  await page.screenshot({ path: shot("05-needs-info"), fullPage: true });
});

test("start form shows validation and an unavailable LLM provider", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("radio", { name: /Claude/ })).toBeDisabled();
  await expect(page.getByText("Set ANTHROPIC_API_KEY to enable")).toBeVisible();
  await page.getByLabel("What did you notice?").fill("hm");
  await expect(page.getByRole("button", { name: "Start investigation" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: shot("00-home"), fullPage: true });
});
