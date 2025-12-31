import { describe, expect, it } from "vitest";
import { ApiError } from "../src/core/errors";
import { buildDraftSummary, parseMenu, searchMenu, validateSelections } from "../src/core/menu";

const sampleMenu = {
  categories: [{ id: "cat-1", name: "Entrees", itemIds: ["item-1"] }],
  items: [
    {
      id: "item-1",
      name: "Classic Burger",
      priceCents: 1000,
      description: "Tasty",
      modifierGroupIds: ["mod-1"],
      synonyms: ["burger", "cheeseburger"],
    },
  ],
  modifierGroups: [
    {
      id: "mod-1",
      name: "Cheese",
      requiredMin: 1,
      requiredMax: 2,
      optionIds: ["opt-1", "opt-2"],
    },
  ],
  modifierOptions: [
    { id: "opt-1", name: "Cheddar", priceDeltaCents: 100 },
    { id: "opt-2", name: "Swiss", priceDeltaCents: 200 },
  ],
};

describe("menu helpers", () => {
  it("validates and prices selections with modifiers", () => {
    const menu = parseMenu(sampleMenu);
    const summary = validateSelections(menu, [
      {
        itemId: "item-1",
        quantity: 2,
        modifiers: [{ groupId: "mod-1", optionIds: ["opt-1", "opt-2"] }],
      },
    ]);

    expect(summary.subtotalCents).toBe(2600);
    expect(summary.items[0]?.lineSubtotalCents).toBe(2600);
  });

  it("throws when required modifiers are missing", () => {
    const menu = parseMenu(sampleMenu);
    try {
      validateSelections(menu, [
        {
          itemId: "item-1",
          quantity: 1,
          modifiers: [],
        },
      ]);
      throw new Error("expected error");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).toBe(400);
    }
  });

  it("throws when modifier option is invalid", () => {
    const menu = parseMenu(sampleMenu);
    expect(() =>
      validateSelections(menu, [
        {
          itemId: "item-1",
          quantity: 1,
          modifiers: [{ groupId: "mod-1", optionIds: ["opt-bad"] }],
        },
      ])
    ).toThrowError(ApiError);
  });

  it("searches menu by synonyms", () => {
    const menu = parseMenu(sampleMenu);
    const results = searchMenu(menu, "cheeseburger");
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe("item-1");
  });

  it("builds draft summary with metadata", () => {
    const menu = parseMenu(sampleMenu);
    const summary = buildDraftSummary(
      menu,
      [
        {
          itemId: "item-1",
          quantity: 1,
          modifiers: [{ groupId: "mod-1", optionIds: ["opt-1"] }],
        },
      ],
      "No onions",
      "Taylor",
      "+15551234567"
    );

    expect(summary.notes).toBe("No onions");
    expect(summary.pickupName).toBe("Taylor");
    expect(summary.pickupPhone).toBe("+15551234567");
  });
});
