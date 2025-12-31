import { createHash } from "crypto";
import { db } from "../db/client";
import { ApiError } from "../core/errors";
import { logger } from "../core/logger";
import { config } from "../core/config";
import type { NormalizedMenu, MenuCategory, MenuItem, ModifierGroup, ModifierOption } from "../core/menu";
import { getCloverToken } from "./auth";

type CloverList<T> = {
  elements?: T[];
};

type CloverCategory = {
  id: string;
  name?: string;
};

type CloverModifierGroup = {
  id: string;
  name?: string;
  minRequired?: number;
  maxRequired?: number;
  min?: number;
  max?: number;
  modifierOptions?: CloverList<CloverModifierOption>;
};

type CloverModifierOption = {
  id: string;
  name?: string;
  price?: number | string;
};

type CloverItem = {
  id: string;
  name?: string;
  price?: number | string;
  description?: string;
  categories?: CloverList<CloverCategory>;
  modifierGroups?: CloverList<CloverModifierGroup>;
};

function extractElements<T>(input: unknown): T[] {
  if (!input) return [];
  if (Array.isArray(input)) return input as T[];
  const asList = input as CloverList<T>;
  if (Array.isArray(asList.elements)) return asList.elements as T[];
  return [];
}

function parseNumber(input: unknown, fallback = 0): number {
  if (typeof input === "number") return Number.isFinite(input) ? input : fallback;
  if (typeof input === "string") {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function parsePriceCents(input: unknown): number {
  return Math.round(parseNumber(input, 0));
}

async function cloverGet(baseUrl: string, path: string, token: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const status = response.status >= 500 ? 502 : 400;
    throw new ApiError(status, "clover request failed", { status: response.status, body: data || text, path });
  }

  return data || {};
}

async function fetchCloverList<T>(
  baseUrl: string,
  path: string,
  token: string,
  expand?: string
): Promise<T[]> {
  const limit = 200;
  let offset = 0;
  const results: T[] = [];

  while (true) {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    if (expand) {
      url.searchParams.set("expand", expand);
    }

    const payload = await cloverGet(url.origin, `${url.pathname}${url.search}`, token);
    const elements = extractElements<T>(payload);
    results.push(...elements);

    if (elements.length < limit) {
      break;
    }
    offset += limit;
  }

  return results;
}

async function fetchWithFallback<T>(
  baseUrl: string,
  paths: string[],
  token: string,
  expand?: string
): Promise<T[]> {
  let lastError: unknown = null;
  for (const path of paths) {
    try {
      return await fetchCloverList<T>(baseUrl, path, token, expand);
    } catch (error) {
      const apiError = error as ApiError;
      const status = (apiError?.details as any)?.status;
      if (status === 404 || status === 405) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  if (lastError) {
    throw lastError;
  }
  return [];
}

async function fetchItemModifierGroups(
  baseUrl: string,
  merchantId: string,
  itemId: string,
  token: string
): Promise<CloverModifierGroup[]> {
  const payload = await cloverGet(
    baseUrl,
    `/v3/merchants/${merchantId}/items/${itemId}?expand=modifierGroups,modifierGroups.modifierOptions`,
    token
  );
  const item = payload as CloverItem;
  return extractElements<CloverModifierGroup>(item.modifierGroups);
}

async function fetchModifierOptionsForGroup(
  baseUrl: string,
  merchantId: string,
  groupId: string,
  token: string
): Promise<CloverModifierOption[]> {
  return fetchWithFallback<CloverModifierOption>(
    baseUrl,
    [
      `/v3/merchants/${merchantId}/modifier_groups/${groupId}/modifier_options`,
      `/v3/merchants/${merchantId}/modifier_groups/${groupId}/modifierOptions`,
    ],
    token
  );
}

function normalizeGroup(group: CloverModifierGroup): ModifierGroup {
  const minRequired = Math.max(0, parseNumber(group.minRequired ?? group.min, 0));
  let maxRequired = Math.max(0, parseNumber(group.maxRequired ?? group.max, minRequired));
  if (maxRequired === 0 && minRequired > 0) {
    maxRequired = minRequired;
  }

  return {
    id: group.id,
    name: group.name || "Modifier",
    requiredMin: minRequired,
    requiredMax: maxRequired,
    optionIds: [],
    externalIds: {
      clover: {
        modifierGroupId: group.id,
      },
    },
  };
}

function normalizeOption(option: CloverModifierOption): ModifierOption {
  return {
    id: option.id,
    name: option.name || "Option",
    priceDeltaCents: parsePriceCents(option.price),
    externalIds: {
      clover: {
        modifierOptionId: option.id,
      },
    },
  };
}

export async function syncCloverMenu(restaurantId: string): Promise<{
  version: number;
  counts: { categories: number; items: number; modifierGroups: number; modifierOptions: number };
}> {
  if (config.cloverMock) {
    throw new ApiError(400, "clover mock enabled; set CLOVER_MOCK=false to sync menu");
  }

  const { token, baseUrl, merchantId } = await getCloverToken(restaurantId);

  const items = await fetchCloverList<CloverItem>(
    baseUrl,
    `/v3/merchants/${merchantId}/items`,
    token,
    "categories,modifierGroups,modifierGroups.modifierOptions"
  );

  if (items.length === 0) {
    throw new ApiError(400, "clover returned no items");
  }

  const categoryMap = new Map<string, MenuCategory>();
  const groupMap = new Map<string, ModifierGroup>();
  const optionMap = new Map<string, ModifierOption>();
  const groupsNeedingOptions = new Set<string>();
  const normalizedItems: MenuItem[] = [];

  for (const item of items) {
    if (!item?.id || !item?.name) {
      continue;
    }

    const categoryList = extractElements<CloverCategory>(item.categories);
    if (categoryList.length === 0) {
      const uncategorizedId = "cat-uncategorized";
      if (!categoryMap.has(uncategorizedId)) {
        categoryMap.set(uncategorizedId, { id: uncategorizedId, name: "Uncategorized", itemIds: [] });
      }
      categoryMap.get(uncategorizedId)?.itemIds.push(item.id);
    } else {
      for (const category of categoryList) {
        if (!category?.id) continue;
        if (!categoryMap.has(category.id)) {
          categoryMap.set(category.id, { id: category.id, name: category.name || "Category", itemIds: [] });
        }
        categoryMap.get(category.id)?.itemIds.push(item.id);
      }
    }

    let groupList = extractElements<CloverModifierGroup>(item.modifierGroups);
    if (groupList.length === 0) {
      groupList = await fetchItemModifierGroups(baseUrl, merchantId, item.id, token);
    }

    const modifierGroupIds = new Set<string>();
    for (const group of groupList) {
      if (!group?.id) continue;
      modifierGroupIds.add(group.id);
      const normalizedGroup = groupMap.get(group.id) || normalizeGroup(group);
      groupMap.set(group.id, normalizedGroup);

      const groupOptions = extractElements<CloverModifierOption>(group.modifierOptions);
      if (groupOptions.length > 0) {
        for (const option of groupOptions) {
          if (!option?.id) continue;
          if (!optionMap.has(option.id)) {
            optionMap.set(option.id, normalizeOption(option));
          }
          normalizedGroup.optionIds.push(option.id);
        }
      } else {
        groupsNeedingOptions.add(group.id);
      }
    }

    normalizedItems.push({
      id: item.id,
      name: item.name,
      priceCents: parsePriceCents(item.price),
      description: item.description,
      modifierGroupIds: Array.from(modifierGroupIds),
      synonyms: [],
      externalIds: {
        clover: {
          itemId: item.id,
        },
      },
    });
  }

  for (const groupId of groupsNeedingOptions) {
    const group = groupMap.get(groupId);
    if (!group) continue;
    const options = await fetchModifierOptionsForGroup(baseUrl, merchantId, group.id, token);
    for (const option of options) {
      if (!option?.id) continue;
      if (!optionMap.has(option.id)) {
        optionMap.set(option.id, normalizeOption(option));
      }
      group.optionIds.push(option.id);
    }
  }

  for (const category of categoryMap.values()) {
    category.itemIds = Array.from(new Set(category.itemIds));
  }

  for (const group of groupMap.values()) {
    group.optionIds = Array.from(new Set(group.optionIds));
  }

  const menu: NormalizedMenu = {
    categories: Array.from(categoryMap.values()),
    items: normalizedItems,
    modifierGroups: Array.from(groupMap.values()),
    modifierOptions: Array.from(optionMap.values()),
  };

  const sourceHash = createHash("sha256").update(JSON.stringify(menu)).digest("hex");
  const existing = await db.query<{ version: number }>(
    "SELECT version FROM menus WHERE restaurant_id = $1",
    [restaurantId]
  );
  const nextVersion = existing.rows[0] ? existing.rows[0].version + 1 : 1;

  await db.query(
    "INSERT INTO menus (restaurant_id, version, normalized_json, source_hash, last_sync_at) VALUES ($1, $2, $3, $4, now()) ON CONFLICT (restaurant_id) DO UPDATE SET version = EXCLUDED.version, normalized_json = EXCLUDED.normalized_json, source_hash = EXCLUDED.source_hash, last_sync_at = now()",
    [restaurantId, nextVersion, menu, sourceHash]
  );

  logger.info(
    {
      restaurantId,
      merchantId,
      counts: {
        categories: menu.categories.length,
        items: menu.items.length,
        modifierGroups: menu.modifierGroups.length,
        modifierOptions: menu.modifierOptions.length,
      },
    },
    "clover menu synced"
  );

  return {
    version: nextVersion,
    counts: {
      categories: menu.categories.length,
      items: menu.items.length,
      modifierGroups: menu.modifierGroups.length,
      modifierOptions: menu.modifierOptions.length,
    },
  };
}
