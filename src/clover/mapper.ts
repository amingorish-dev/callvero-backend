import { ApiError } from "../core/errors";
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
  const groupIndex = new Map(menu.modifierGroups.map((group) => [group.id, group] as const));
  const optionIndex = new Map(menu.modifierOptions.map((option) => [option.id, option] as const));

  const lineItems = draft.selections.map((selection) => {
    const item = itemIndex.get(selection.itemId);
    const cloverItemId = item?.externalIds?.clover?.itemId;
    if (!cloverItemId) {
      throw new ApiError(400, `missing clover item mapping for ${selection.itemId}`);
    }

    return {
      // Clover IDs must be stored in menu.externalIds.clover.
      itemId: cloverItemId,
      name: item?.name,
      quantity: selection.quantity,
      modifications: (selection.modifiers || []).flatMap((modifier) =>
        modifier.optionIds.map((optionId) => {
          const group = groupIndex.get(modifier.groupId);
          const option = optionIndex.get(optionId);
          const cloverGroupId = group?.externalIds?.clover?.modifierGroupId;
          const cloverOptionId = option?.externalIds?.clover?.modifierOptionId;

          if (!cloverGroupId || !cloverOptionId) {
            throw new ApiError(400, `missing clover modifier mapping for ${modifier.groupId}:${optionId}`);
          }

          return {
            modifierGroupId: cloverGroupId,
            modifierOptionId: cloverOptionId,
          };
        })
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
