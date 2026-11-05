import { expect, test } from "@playwright/test";
import { expectNoFindings } from "@codepress/interactions-playwright";

test("pricing page has no UI findings", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("plan-pro-cta")).toBeVisible();
  // Fails with one line per finding: check, elements, evidence, fingerprint.
  // To accept a finding you decided is intended, pass its fingerprint in
  // ignoreFingerprints (and write down why).
  await expectNoFindings(page);
});
