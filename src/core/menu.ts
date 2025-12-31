import { ApiError } from "./errors";

export type ExternalIds = {
  toast?: {
    itemId?: string;
    modifierGroupId?: string;
    modifierOptionId?: string;
  };
  clover?: {
    itemId?: string;
    modifierGroupId?: string;
    modifierOptionId?: string;
  };
};

export type MenuCategory = {
  id: string;
  name: string;
  itemIds: string[];
};

export type MenuItem = {
  id: string;
  name: string;
  priceCents: number;
  description?: string;
  modifierGroupIds: string[];
  synonyms: string[];
  externalIds?: ExternalIds;
};

export type ModifierGroup = {
  id: string;
  name: string;
  requiredMin: number;
  requiredMax: number;
  optionIds: string[];
  externalIds?: ExternalIds;
};

export type ModifierOption = {
  id: string;
  name: string;
  priceDeltaCents: number;
  externalIds?: ExternalIds;
};

export type NormalizedMenu = {
  categories: MenuCategory[];
  items: MenuItem[];
  modifierGroups: ModifierGroup[];
  modifierOptions: ModifierOption[];
};

export type SelectionModifier = {
  groupId: string;
  optionIds: string[];
};

export type Selection = {
  itemId: string;
  quantity: number;
  modifiers?: SelectionModifier[];
  specialInstructions?: string;
};

export type DraftSummaryItem = {
  itemId: string;
  name: string;
  quantity: number;
  modifiers: Array<{ groupId: string; groupName: string; options: Array<{ id: string; name: string }> }>;
  specialInstructions?: string;
  lineSubtotalCents: number;
};

export type DraftSummary = {
  items: DraftSummaryItem[];
  subtotalCents: number;
  notes?: string;
  pickupName?: string;
  pickupPhone?: string;
};

function buildIndex(menu: NormalizedMenu) {
  const items = new Map(menu.items.map((item) => [item.id, item] as const));
  const groups = new Map(menu.modifierGroups.map((group) => [group.id, group] as const));
  const options = new Map(menu.modifierOptions.map((option) => [option.id, option] as const));
  return { items, groups, options };
}

export function parseMenu(input: unknown): NormalizedMenu {
  if (!input || typeof input !== "object") {
    throw new ApiError(500, "menu is invalid");
  }

  const menu = input as NormalizedMenu;
  if (!Array.isArray(menu.categories) || !Array.isArray(menu.items)) {
    throw new ApiError(500, "menu is invalid");
  }
  if (!Array.isArray(menu.modifierGroups) || !Array.isArray(menu.modifierOptions)) {
    throw new ApiError(500, "menu is invalid");
  }

  return menu;
}

export function validateSelections(menu: NormalizedMenu, selections: Selection[]): DraftSummary {
  const { items, groups, options } = buildIndex(menu);
  const errors: string[] = [];
  const summaryItems: DraftSummaryItem[] = [];
  let subtotalCents = 0;

  selections.forEach((selection, index) => {
    const item = items.get(selection.itemId);
    if (!item) {
      errors.push(`selection[${index}].itemId not found`);
      return;
    }

    const quantity = Number(selection.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      errors.push(`selection[${index}].quantity must be >= 1`);
      return;
    }

    const modifierMap = new Map<string, SelectionModifier>();
    for (const modifier of selection.modifiers || []) {
      modifierMap.set(modifier.groupId, modifier);
    }

    const modifierSummaries: DraftSummaryItem["modifiers"] = [];
    let lineSubtotal = item.priceCents * quantity;

    for (const groupId of item.modifierGroupIds || []) {
      const group = groups.get(groupId);
      if (!group) {
        errors.push(`menu missing modifierGroup ${groupId} for item ${item.id}`);
        continue;
      }

      const provided = modifierMap.get(groupId);
      const optionIds = provided?.optionIds || [];
      const uniqueOptionIds = Array.from(new Set(optionIds));

      if (uniqueOptionIds.length < group.requiredMin) {
        errors.push(`item ${item.name} requires at least ${group.requiredMin} option(s) for ${group.name}`);
        continue;
      }

      if (uniqueOptionIds.length > group.requiredMax) {
        errors.push(`item ${item.name} allows at most ${group.requiredMax} option(s) for ${group.name}`);
        continue;
      }

      const optionSummaries: Array<{ id: string; name: string }> = [];
      for (const optionId of uniqueOptionIds) {
        if (!group.optionIds.includes(optionId)) {
          errors.push(`option ${optionId} is not valid for modifier group ${group.name}`);
          continue;
        }
        const option = options.get(optionId);
        if (!option) {
          errors.push(`modifier option ${optionId} not found`);
          continue;
        }
        optionSummaries.push({ id: option.id, name: option.name });
        lineSubtotal += option.priceDeltaCents * quantity;
      }

      if (optionSummaries.length > 0 || group.requiredMin > 0) {
        modifierSummaries.push({
          groupId: group.id,
          groupName: group.name,
          options: optionSummaries,
        });
      }
    }

    for (const [groupId] of modifierMap) {
      if (!(item.modifierGroupIds || []).includes(groupId)) {
        errors.push(`modifier group ${groupId} is not valid for item ${item.name}`);
      }
    }

    summaryItems.push({
      itemId: item.id,
      name: item.name,
      quantity,
      modifiers: modifierSummaries,
      specialInstructions: selection.specialInstructions,
      lineSubtotalCents: lineSubtotal,
    });
    subtotalCents += lineSubtotal;
  });

  if (errors.length > 0) {
    throw new ApiError(400, "invalid selections", { errors });
  }

  return {
    items: summaryItems,
    subtotalCents,
  };
}

export function searchMenu(menu: NormalizedMenu, query: string, limit = 5) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const tokens = needle.split(/\s+/);
  const scored = menu.items.map((item) => {
    const haystack = [item.name, ...(item.synonyms || [])].join(" ").toLowerCase();
    let score = 0;
    if (haystack.includes(needle)) score += 10;
    for (const token of tokens) {
      if (haystack.includes(token)) score += 2;
    }
    return { item, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function buildDraftSummary(
  menu: NormalizedMenu,
  selections: Selection[],
  notes?: string,
  pickupName?: string,
  pickupPhone?: string
): DraftSummary {
  const draft = validateSelections(menu, selections);
  return {
    ...draft,
    notes,
    pickupName,
    pickupPhone,
  };
}
