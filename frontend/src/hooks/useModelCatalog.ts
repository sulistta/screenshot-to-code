import { useQuery } from "@tanstack/react-query";
import { native } from "@/lib/native";
import type { Settings } from "@/types";
import type { CatalogModel } from "@/components/studio/modelOptions";

/** Shared, cached catalogue of built-in models for every model/effort picker. */
export function useModelCatalog(settings: Settings | null) {
  // The fingerprint key reloads whenever providers change so new, edited, or
  // removed providers are reflected immediately in every selector.
  const fingerprint = JSON.stringify({
    custom: settings?.customProviders ?? [],
    active: settings?.activeCustomProviderId ?? null,
  });
  return useQuery({
    queryKey: ["model-catalog", fingerprint],
    queryFn: () => native<CatalogModel[]>("list_models"),
  });
}
