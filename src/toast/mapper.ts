import { NormalizedMenu, parseMenu, Selection } from "../core/menu";

export type DraftOrder = {
  selections: Selection[];
  notes?: string;
  pickupName?: string;
  pickupPhone?: string;
};

export function buildToastOrderPayload(menuInput: unknown, draft: DraftOrder): Record<string, unknown> {
  const menu: NormalizedMenu = parseMenu(menuInput);
  const itemIndex = new Map(menu.items.map((item) => [item.id, item] as const));

  const items = draft.selections.map((selection) => {
    const item = itemIndex.get(selection.itemId);
    return {
      // TODO: map to Toast menu item GUIDs when available.
      itemId: selection.itemId,
      name: item?.name,
      quantity: selection.quantity,
      modifiers: (selection.modifiers || []).flatMap((modifier) =>
        modifier.optionIds.map((optionId) => ({
          // TODO: map to Toast modifier option GUIDs.
          modifierGroupId: modifier.groupId,
          modifierOptionId: optionId,
        }))
      ),
      specialInstructions: selection.specialInstructions,
    };
  });

  return {
    source: "PHONE",
    diningOption: "TAKE_OUT",
    customer: {
      name: draft.pickupName,
      phone: draft.pickupPhone,
    },
    items,
    notes: draft.notes,
  };
}
