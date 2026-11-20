import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@apollo/client';
import { GeoJSON as LeafletGeoJSON, MapContainer, TileLayer, useMap } from 'react-leaflet';
import type { PathOptions } from 'leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { parseGeometry } from '@/pages/regions/regionUtils';
import { LIST_REGISTERED_BOUNDARY_REGIONS } from '@/graphql/queries/regions';
import { fetchSpatialLayers, spatialLayersAvailable } from '@/lib/spatial-layers';

interface SpatialLayerCatalogEntry {
  id: string;
  label: string;
  uri: string;
  source_type?: string;
  geometry_type?: string;
  default_filter_field?: string;
  crs?: string;
  format?: string;
  tags?: string[];
  /** URI used by the ETL when display geometry comes from registered regions. */
  source_uri?: string;
  registered_category_id?: string;
}

export type SpatialLayerSelection = Pick<
  SpatialLayerCatalogEntry,
  | 'id'
  | 'label'
  | 'uri'
  | 'source_type'
  | 'geometry_type'
  | 'default_filter_field'
  | 'crs'
  | 'format'
  | 'tags'
  | 'source_uri'
  | 'registered_category_id'
>;

export interface SpatialFeatureSelection {
  filterField: string;
  filterValue: string;
  label: string;
  layer?: SpatialLayerSelection;
  geometry?: GeoJSON.Geometry;
}

export interface SpatialSelection {
  layer?: SpatialLayerSelection;
  feature?: SpatialFeatureSelection;
}

interface SpatialScopeMapProps {
  geometries?: unknown[];
  label?: string | null;
  scopeId?: string | null;
  sourceUri?: string | null;
  filterField?: string | null;
  filterValue?: string | null;
  onLayerSelect?: (layer: SpatialLayerSelection) => void;
  onFeatureSelect?: (feature: SpatialFeatureSelection) => void;
  disabled?: boolean;
  height?: string;
}

type RegisteredBoundaryRegion = {
  id: string;
  name: string;
  category_id?: string | null;
  region_category?: {
    id: string;
    name: string;
  } | null;
  geometries: Array<{ geometry: unknown }>;
};

type RegisteredBoundaryRegionsData = {
  region: RegisteredBoundaryRegion[];
};

// The Problem Framing map uses hydrology boundaries. Include its registered
// child categories (for example Ground water Availability Models) without
// pulling the much larger administrative level datasets into every map.
const REGISTERED_BOUNDARY_CATEGORY_IDS = ['hydrology'];

/** Cartographic preview of the spatial scope carried by the problem statement. */
export function SpatialScopeMap({
  geometries = [],
  label,
  scopeId,
  sourceUri,
  filterField,
  filterValue,
  onLayerSelect,
  onFeatureSelect,
  disabled = false,
  height = '360px',
}: SpatialScopeMapProps) {
  const layersAvailable = spatialLayersAvailable();
  const [catalogLayers, setCatalogLayers] = useState<SpatialLayerCatalogEntry[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState('');
  const [layerFeatures, setLayerFeatures] = useState<GeoJSON.Feature[]>([]);
  const [selectedFeatureValue, setSelectedFeatureValue] = useState('');
  const [layerLoading, setLayerLoading] = useState(false);
  const [layerError, setLayerError] = useState<string | null>(null);

  const { data: registeredBoundaryData } = useQuery<RegisteredBoundaryRegionsData>(
    LIST_REGISTERED_BOUNDARY_REGIONS,
    { variables: { categoryIds: REGISTERED_BOUNDARY_CATEGORY_IDS } },
  );
  const registeredRegions = useMemo(
    () => registeredBoundaryData?.region ?? [],
    [registeredBoundaryData],
  );
  const registeredLayers = useMemo<SpatialLayerCatalogEntry[]>(() => {
    const regionsByCategory = new Map<string, RegisteredBoundaryRegion[]>();
    for (const region of registeredRegions) {
      const categoryId = region.category_id?.trim();
      if (!categoryId) continue;
      const regions = regionsByCategory.get(categoryId) ?? [];
      regions.push(region);
      regionsByCategory.set(categoryId, regions);
    }

    return [...regionsByCategory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([categoryId, regions]) => {
        const categoryName = regions.find((region) => region.region_category?.name)?.region_category
          ?.name;
        return {
          id: `mint_registered_${categoryId}`,
          label:
            categoryId === 'hydrology'
              ? 'MINT registered boundaries'
              : (categoryName ?? categoryId),
          uri: `mint://regions/${categoryId}`,
          source_type: 'mint-regions',
          geometry_type: 'polygon',
          default_filter_field: 'region_id',
          crs: 'EPSG:4326',
          format: 'geojson',
          tags: ['mint', 'registered', 'boundary'],
          registered_category_id: categoryId,
        };
      });
  }, [registeredRegions]);
  const layers = useMemo(
    () => [...registeredLayers, ...catalogLayers],
    [catalogLayers, registeredLayers],
  );

  useEffect(() => {
    if (!layersAvailable) return;
    const controller = new AbortController();
    void fetchSpatialLayers<SpatialLayerCatalogEntry>(controller.signal)
      .then((nextLayers) => {
        if (controller.signal.aborted) return;
        setCatalogLayers(nextLayers);
        setSelectedLayerId((current) => {
          const availableLayers = [...registeredLayers, ...nextLayers];
          const sourceMatch = sourceUri?.trim()
            ? availableLayers.find(
                (layer) => layer.uri === sourceUri.trim() || layer.source_uri === sourceUri.trim(),
              )
            : undefined;
          if (sourceMatch) return sourceMatch.id;
          if (current && availableLayers.some((layer) => layer.id === current)) return current;
          return (
            registeredLayers[0]?.id ??
            nextLayers.find((layer) => layer.tags?.includes('gma'))?.id ??
            nextLayers[0]?.id ??
            ''
          );
        });
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string })?.name !== 'AbortError') {
          setLayerError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => controller.abort();
  }, [layersAvailable, registeredLayers, sourceUri]);

  const selectedLayer = layers.find((layer) => layer.id === selectedLayerId);

  const activeFilterField = filterField?.trim() || selectedLayer?.default_filter_field;

  const featureOptions = useMemo(() => {
    if (!activeFilterField) return [];
    const options = layerFeatures.flatMap((feature) => {
      const rawValue = feature.properties?.[activeFilterField];
      if (rawValue == null || String(rawValue).trim() === '') return [];
      const value = String(rawValue);
      const name =
        feature.properties?.GMAName ??
        feature.properties?.GMA_Name ??
        feature.properties?.GMA_NAME ??
        feature.properties?.Name ??
        feature.properties?.name ??
        feature.properties?.region_name ??
        feature.properties?.label ??
        '';
      return [
        {
          value,
          label: name ? `${value} — ${String(name)}` : value,
        },
      ];
    });
    return options
      .filter(
        (option, index) =>
          options.findIndex((candidate) => candidate.value === option.value) === index,
      )
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }));
  }, [activeFilterField, layerFeatures]);

  useEffect(() => {
    const nextValue = filterValue?.trim() ?? '';
    setSelectedFeatureValue(
      nextValue && featureOptions.some((option) => option.value === nextValue) ? nextValue : '',
    );
  }, [featureOptions, filterValue]);

  useEffect(() => {
    if (!selectedLayer) {
      setLayerFeatures([]);
      return;
    }
    if (selectedLayer.source_type === 'mint-regions') {
      const categoryId = selectedLayer.registered_category_id;
      setLayerFeatures(
        registeredRegions
          .filter((region) => !categoryId || region.category_id === categoryId)
          .flatMap((region) =>
            region.geometries.flatMap(({ geometry }) => {
              const parsed = parseGeometry(
                geometry as string | GeoJSON.Geometry | null | undefined,
              );
              return parsed
                ? [
                    {
                      type: 'Feature',
                      properties: {
                        // Imported regions use a parent-prefixed database ID;
                        // the suffix preserves the source's stable filter value
                        // (for example GMAnum=12) for ETL arguments.
                        region_id: region.id.split('__').pop() ?? region.id,
                        region_name: region.name,
                      },
                      geometry: parsed,
                    } as GeoJSON.Feature,
                  ]
                : [];
            }),
          ),
      );
      setLayerLoading(false);
      setLayerError(null);
      return;
    }
    const sourceIsCatalogLayer = layers.some(
      (layer) => layer.uri === sourceUri?.trim() || layer.source_uri === sourceUri?.trim(),
    );
    const activeUri =
      sourceUri?.trim() && !sourceIsCatalogLayer ? sourceUri.trim() : selectedLayer.uri;
    const queryUrl = spatialLayerQueryUrl(activeUri);
    if (!queryUrl) {
      setLayerFeatures([]);
      setLayerError('The selected spatial layer does not expose a GeoJSON query endpoint.');
      return;
    }
    const controller = new AbortController();
    setLayerFeatures([]);
    setLayerLoading(true);
    setLayerError(null);
    void fetch(queryUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Spatial layer returned ${response.status}`);
        return (await response.json()) as GeoJSON.FeatureCollection;
      })
      .then((payload) => {
        if (!controller.signal.aborted) setLayerFeatures(payload.features ?? []);
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string })?.name !== 'AbortError') {
          setLayerFeatures([]);
          setLayerError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLayerLoading(false);
      });
    return () => controller.abort();
  }, [layers, registeredRegions, selectedLayer, sourceUri]);

  const selectedScopeFeatures = useMemo<GeoJSON.Feature[]>(() => {
    return geometries.flatMap((value) => {
      const geometry = parseGeometry(value as string | GeoJSON.Geometry | null | undefined);
      return geometry
        ? [
            {
              type: 'Feature',
              properties: {
                spatialScopeName: label ?? scopeId ?? 'Selected spatial scope',
                selectedScope: true,
              },
              geometry,
            } as GeoJSON.Feature,
          ]
        : [];
    });
  }, [geometries, label, scopeId]);

  const featureCollection = useMemo<GeoJSON.FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: [
        ...layerFeatures.map((feature) => ({
          ...feature,
          properties: {
            ...(feature.properties ?? {}),
            catalogLayer: true,
            selectedBoundary:
              Boolean(selectedFeatureValue) &&
              String(feature.properties?.[activeFilterField ?? '']) === selectedFeatureValue,
          },
        })),
        ...selectedScopeFeatures,
      ],
    }),
    [activeFilterField, layerFeatures, selectedFeatureValue, selectedScopeFeatures],
  );

  const sourceIsCustom = Boolean(
    sourceUri?.trim() &&
    !layers.some(
      (layer) => layer.uri === sourceUri.trim() || layer.source_uri === sourceUri.trim(),
    ),
  );
  const activeLayerLabel = sourceIsCustom ? 'Custom geometry source' : selectedLayer?.label;
  const focusedFeatures = selectedFeatureValue
    ? layerFeatures.filter(
        (feature) => String(feature.properties?.[activeFilterField ?? '']) === selectedFeatureValue,
      )
    : [];

  const style = (feature?: GeoJSON.Feature): PathOptions =>
    feature?.properties?.selectedBoundary
      ? {
          color: '#b91c1c',
          weight: 3,
          fillColor: '#ef4444',
          fillOpacity: 0.28,
        }
      : feature?.properties?.selectedScope
        ? {
            color: '#64748b',
            weight: 1.5,
            dashArray: '5 4',
            fillOpacity: 0,
            interactive: false,
          }
        : {
            color: '#1d4ed8',
            weight: 1.5,
            fillColor: '#3b82f6',
            fillOpacity: 0.12,
          };

  return (
    <div className="space-y-1">
      <div className="text-xs font-semibold">Spatial context map</div>
      {layers.length > 0 && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <span>Boundary layer</span>
            <select
              aria-label="Spatial boundary layer"
              className="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
              value={selectedLayerId}
              disabled={disabled}
              onChange={(event) => {
                const nextId = event.target.value;
                setSelectedLayerId(nextId);
                setSelectedFeatureValue('');
                const nextLayer = layers.find((layer) => layer.id === nextId);
                if (nextLayer) onLayerSelect?.(nextLayer);
              }}
            >
              {layers.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.label}
                </option>
              ))}
            </select>
          </label>
          {featureOptions.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-gray-600">
              <span>Boundary</span>
              <select
                aria-label="Spatial boundary feature"
                className="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
                value={selectedFeatureValue}
                disabled={disabled}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  setSelectedFeatureValue(nextValue);
                  const option = featureOptions.find((item) => item.value === nextValue);
                  if (option && activeFilterField) {
                    const selectedFeature = layerFeatures.find(
                      (feature) => String(feature.properties?.[activeFilterField]) === nextValue,
                    );
                    onFeatureSelect?.({
                      filterField: activeFilterField,
                      filterValue: option.value,
                      label: option.label,
                      layer: selectedLayer,
                      geometry: selectedFeature?.geometry ?? undefined,
                    });
                  }
                }}
              >
                <option value="">All boundaries</option>
                {featureOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      <div className="relative overflow-hidden rounded-md border" style={{ height, zIndex: 0 }}>
        <MapContainer
          center={[31, -99]}
          zoom={5}
          style={{ width: '100%', height: '100%' }}
          scrollWheelZoom
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <LeafletGeoJSON
            key={`${selectedLayerId}-${sourceUri ?? ''}-${label ?? 'scope'}-${featureCollection.features.length}-${selectedFeatureValue}`}
            data={featureCollection}
            style={style}
            onEachFeature={(feature, layer) => {
              const isStoredScope = Boolean(feature.properties?.selectedScope);
              const featureValue = activeFilterField
                ? feature.properties?.[activeFilterField]
                : undefined;
              const option =
                featureValue == null
                  ? undefined
                  : featureOptions.find((item) => item.value === String(featureValue));
              const scopeName =
                option?.label ?? (featureValue == null ? activeLayerLabel : String(featureValue));
              if (scopeName && (!isStoredScope || layerFeatures.length === 0)) {
                layer.bindTooltip(String(scopeName), { sticky: true });
              }
              if (
                !disabled &&
                activeFilterField &&
                feature.properties?.[activeFilterField] != null
              ) {
                layer.on('click', () => {
                  const value = String(feature.properties?.[activeFilterField]);
                  const option = featureOptions.find((item) => item.value === value);
                  setSelectedFeatureValue(value);
                  onFeatureSelect?.({
                    filterField: activeFilterField,
                    filterValue: value,
                    label: option?.label ?? value,
                    layer: selectedLayer,
                    geometry: feature.geometry ?? undefined,
                  });
                });
              }
            }}
          />
          <FitSpatialScope
            featureCollection={featureCollection}
            focusedFeatures={focusedFeatures}
          />
        </MapContainer>
        {featureCollection.features.length === 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-white/90 px-2 py-1 text-xs text-gray-600">
            No stored boundary geometry is available for this spatial scope.
          </div>
        )}
      </div>
      <div className="flex justify-between gap-2 text-[11px] text-gray-500">
        <span>
          {activeLayerLabel ?? 'Stored region geometry'}
          {scopeId ? ` · ${label ?? scopeId}` : ''}
        </span>
        <span>{layerLoading ? 'Loading layer…' : (layerError ?? 'OpenStreetMap base map')}</span>
      </div>
    </div>
  );
}

function spatialLayerQueryUrl(uri: string): string | null {
  try {
    const url = new URL(uri);
    if (!/(FeatureServer|MapServer)\/\d+\/?$/i.test(url.pathname)) return null;
    url.pathname = `${url.pathname.replace(/\/$/, '')}/query`;
    url.search = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'true',
      f: 'geojson',
    }).toString();
    return url.toString();
  } catch {
    return null;
  }
}

function FitSpatialScope({
  featureCollection,
  focusedFeatures,
}: {
  featureCollection: GeoJSON.FeatureCollection;
  focusedFeatures: GeoJSON.Feature[];
}) {
  const map = useMap();

  useEffect(() => {
    const featuresToFit = focusedFeatures.length > 0 ? focusedFeatures : featureCollection.features;
    if (featuresToFit.length === 0) return;
    const focusCollection: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: featuresToFit,
    };
    const layer = L.geoJSON(focusCollection);
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] });
  }, [featureCollection, focusedFeatures, map]);

  return null;
}
