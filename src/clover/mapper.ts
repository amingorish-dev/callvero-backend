import { NormalizedMenu, parseMenu, Selection } from "../core/menu";

export type DraftOrder = {
  selections: Selection[];
  notes?: string;
  pickupName?: string;
  pickupPhone?: string;
};

export function buildCloverOrderPayload(menuInput: unknown, draft: DraftOrder): Record<string, unknown> {
  const menu: NormalizedMenu = parseMenu(menuInput);
  const itemIndex = new Map(menu.items.map((item) => [item.id, item] as const));

  const lineItems = draft.selections.map((selection) => {
    const item = itemIndex.get(selection.itemId);
    return {
      // TODO: map to Clover item IDs when available.
      itemId: selection.itemId,
      name: item?.name,
      quantity: selection.quantity,
      modifications: (selection.modifiers || []).flatMap((modifier) =>
        modifier.optionIds.map((optionId) => ({
          // TODO: map to Clover modifier IDs.
          modifierGroupId: modifier.groupId,
          modifierOptionId: optionId,
        }))
      ),
      specialInstructions: selection.specialInstructions,
    };
  });

  return {
    orderType: "TAKEOUT",
    title: draft.pickupName,
    note: draft.notes,
    phone: draft.pickupPhone,
    lineItems,
  };
}
