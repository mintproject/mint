import { useCallback, useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, GeoJSON as LeafletGeoJSON, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Plus, Download, AlertCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useAuth } from '@/lib/auth/useAuth';

import { useListRegionsByCategoryQuery } from '@/graphql/generated/graphql';
import { useListRegionCategoriesWithHierarchy } from './useRegionCategories';
import { RegionDatasets } from './RegionDatasets';
import { RegionModels } from './RegionModels';
import {
  type RegionData,
  calculateBoundingBox,
  parseGeometry,
  parseGeoJsonFeatures,
  generateRegionId,
  type NewRegionFromGeoJSON,
} from './regionUtils';
import { fetchSpatialLayers, spatialLayersAvailable } from '@/lib/spatial-layers';
import { getRegionImportAccess, importRegions } from '@/lib/region-import-api';
import { createRegionSubcategory } from '@/lib/region-category-api';

interface RemoteSpatialLayerOption {
  id: string;
  label: string;
  uri: string;
}

function spatialSourceQueryUrl(uri: string): string {
  const url = new URL(uri);
  if (!/(FeatureServer|MapServer)\/\d+\/?$/i.test(url.pathname)) return url.toString();
  url.pathname = `${url.pathname.replace(/\/$/, '')}/query`;
  url.search = new URLSearchParams({
    where: '1=1',
    outFields: '*',
    returnGeometry: 'true',
    f: 'geojson',
  }).toString();
  return url.toString();
}

function asGeoJsonFeatureCollection(payload: unknown): GeoJSON.FeatureCollection | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  if (value.type === 'FeatureCollection' && Array.isArray(value.features)) {
    return value as unknown as GeoJSON.FeatureCollection;
  }
  if (value.type === 'Feature') {
    return { type: 'FeatureCollection', features: [value as unknown as GeoJSON.Feature] };
  }
  if (!Array.isArray(value.features)) return null;
  const features: GeoJSON.Feature[] = value.features.flatMap((item): GeoJSON.Feature[] => {
    if (!item || typeof item !== 'object') return [];
    const feature = item as Record<string, unknown>;
    const geometry = feature.geometry as Record<string, unknown> | null | undefined;
    const attributes = feature.attributes ?? feature.properties ?? {};
    if (!geometry) return [];
    if (geometry.type) {
      return [
        {
          type: 'Feature',
          properties: attributes as Record<string, unknown>,
          geometry: geometry as unknown as GeoJSON.Geometry,
        } as GeoJSON.Feature,
      ];
    }
    if (Array.isArray(geometry.rings)) {
      return [
        {
          type: 'Feature',
          properties: attributes,
          geometry: { type: 'Polygon', coordinates: geometry.rings },
        } as GeoJSON.Feature,
      ];
    }
    if (Array.isArray(geometry.paths)) {
      return [
        {
          type: 'Feature',
          properties: attributes,
          geometry: { type: 'LineString', coordinates: geometry.paths[0] },
        } as GeoJSON.Feature,
      ];
    }
    if (typeof geometry.x === 'number' && typeof geometry.y === 'number') {
      return [
        {
          type: 'Feature',
          properties: attributes,
          geometry: { type: 'Point', coordinates: [geometry.x, geometry.y] },
        } as GeoJSON.Feature,
      ];
    }
    return [];
  });
  return { type: 'FeatureCollection', features };
}

interface RegionsEditorProps {
  regionId?: string;
  regionType?: string;
  /** Optional: override CSS height of the map. Default 320px. */
  mapHeight?: string;
}

/** Map + GeoJSON polygon CRUD + subcategory tabs. */
export function RegionsEditor({
  regionId = 'global',
  regionType = 'administrative',
  mapHeight = '320px',
}: RegionsEditorProps) {
  const { isAuthenticated } = useAuth();
  const [selectedSubcategory, setSelectedSubcategory] = useState<string>('');
  const [selectedRegion, setSelectedRegion] = useState<RegionData | null>(null);
  const [addRegionsOpen, setAddRegionsOpen] = useState(false);
  const [addSubcategoryOpen, setAddSubcategoryOpen] = useState(false);
  const [canImportRegions, setCanImportRegions] = useState(false);
  const [checkingImportAccess, setCheckingImportAccess] = useState(false);

  const {
    categories,
    subcategoriesFor,
    refetch: refetchCategories,
  } = useListRegionCategoriesWithHierarchy();
  const subcategories = subcategoriesFor(regionType);

  const activeCategoryId = selectedSubcategory || regionType;

  const { data, loading, refetch } = useListRegionsByCategoryQuery({
    variables: { categoryId: activeCategoryId },
    skip: !activeCategoryId,
  });

  const regions = data?.region ?? [];

  useEffect(() => {
    let active = true;
    if (!isAuthenticated) {
      setCanImportRegions(false);
      setCheckingImportAccess(false);
      return () => {
        active = false;
      };
    }

    setCheckingImportAccess(true);
    void getRegionImportAccess()
      .then((allowed) => {
        if (active) setCanImportRegions(allowed);
      })
      .catch(() => {
        if (active) setCanImportRegions(false);
      })
      .finally(() => {
        if (active) setCheckingImportAccess(false);
      });

    return () => {
      active = false;
    };
  }, [isAuthenticated]);

  const handleRegionClick = useCallback((region: RegionData) => {
    setSelectedRegion(region);
  }, []);

  const handleSubcategoryChange = (catId: string) => {
    setSelectedSubcategory(catId === regionType ? '' : catId);
    setSelectedRegion(null);
  };

  const downloadGeoJson = () => {
    if (!selectedRegion) return;
    const geojson = {
      type: 'FeatureCollection',
      features: selectedRegion.geometries
        .map((g) => {
          const geometry = parseGeometry(g.geometry);
          if (!geometry) return null;
          return {
            type: 'Feature',
            properties: { id: selectedRegion.id, name: selectedRegion.name },
            geometry,
          };
        })
        .filter(Boolean),
    };
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedRegion.name.replace(/\s+/g, '_').toLowerCase()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const bbox = selectedRegion ? calculateBoundingBox(selectedRegion.geometries) : null;

  const categoryName = categories.find((c) => c.id === regionType)?.name ?? regionType;
  const currentCategoryObj = subcategories.find((sc) => sc.id === activeCategoryId);
  const citation =
    currentCategoryObj?.citation ?? categories.find((c) => c.id === regionType)?.citation;

  return (
    <div className="w-full">
      {/* Subcategory tabs */}
      {(subcategories.length > 0 ||
        (isAuthenticated && canImportRegions && !checkingImportAccess)) && (
        <div className="mb-2 flex items-center gap-1">
          <Tabs value={activeCategoryId} onValueChange={handleSubcategoryChange}>
            <TabsList>
              <TabsTrigger value={regionType}>{categoryName}</TabsTrigger>
              {subcategories.map((sc) => (
                <TabsTrigger key={sc.id} value={sc.id}>
                  {sc.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <button
            type="button"
            className="ml-2 text-gray-400 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
            title="Add subcategory"
            aria-label="Add subcategory"
            disabled={!isAuthenticated || !canImportRegions || checkingImportAccess}
            onClick={() => setAddSubcategoryOpen(true)}
          >
            <Plus className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* Description + citation */}
      <div className="mb-2 flex items-start justify-between">
        <div className="text-sm text-muted-foreground">
          {regionType === 'administrative'
            ? `The following map shows the administrative regions in this area.`
            : `The following map shows the current areas of interest for ${regionType} modeling in this area.`}
          {citation && <div className="mt-1 text-xs italic">{citation}</div>}
        </div>
        {isAuthenticated && canImportRegions && !checkingImportAccess && (
          <Button variant="ghost" size="sm" onClick={() => setAddRegionsOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Add regions
          </Button>
        )}
      </div>

      {/* Map */}
      {loading ? (
        <div
          className="flex items-center justify-center rounded bg-gray-100"
          style={{ height: mapHeight }}
        >
          <LoadingSpinner />
        </div>
      ) : regions.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center gap-2 rounded bg-gray-200 text-base font-semibold text-gray-500"
          style={{ height: mapHeight }}
        >
          <AlertCircle className="h-8 w-8" />
          <span>This category does not have any region yet.</span>
          {isAuthenticated && canImportRegions && !checkingImportAccess && (
            <Button variant="outline" size="sm" onClick={() => setAddRegionsOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> Add new regions
            </Button>
          )}
        </div>
      ) : (
        <div
          style={{ height: mapHeight, isolation: 'isolate', position: 'relative', zIndex: 0 }}
          className="overflow-hidden rounded border"
        >
          <RegionMap
            regions={regions}
            selectedRegion={selectedRegion}
            onRegionClick={handleRegionClick}
          />
        </div>
      )}

      {/* Selected region info */}
      {selectedRegion && (
        <div className="mt-2 flex items-center justify-between text-sm">
          <span>
            <b>Selected region:</b> {selectedRegion.name}{' '}
            <span className="text-muted-foreground">(id: {selectedRegion.id})</span>
          </span>
          {bbox && (
            <span className="flex items-center gap-2">
              <b>Bounding box:</b>
              {bbox.xmin.toFixed(4)},{bbox.ymin.toFixed(4)} – {bbox.xmax.toFixed(4)},
              {bbox.ymax.toFixed(4)}
              <button
                onClick={downloadGeoJson}
                className="flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-gray-100"
              >
                <Download className="h-3 w-3" /> Download
              </button>
            </span>
          )}
        </div>
      )}
      {selectedRegion && (
        <p className="mt-1 text-xs text-muted-foreground">
          <b>Note:</b> Models and Datasets are calculated using the bounding box of the highlighted
          region. Results from overlapping regions may be included.
        </p>
      )}

      {/* Sub-panels */}
      {selectedRegion && (
        <>
          <RegionModels
            regionId={selectedRegion.id}
            regionName={selectedRegion.name}
            regionType={regionType}
          />
          <RegionDatasets
            regionId={selectedRegion.id}
            regionName={selectedRegion.name}
            boundingBox={bbox ?? undefined}
          />
        </>
      )}

      {/* Add regions dialog */}
      <AddRegionsDialog
        open={addRegionsOpen}
        onClose={() => setAddRegionsOpen(false)}
        parentRegionId={regionId}
        regionType={regionType}
        subcategories={subcategories}
        activeCategoryId={activeCategoryId}
        canImportRegions={canImportRegions}
        onSuccess={() => {
          setAddRegionsOpen(false);
          refetch();
        }}
      />
      <AddSubcategoryDialog
        open={addSubcategoryOpen}
        onClose={() => setAddSubcategoryOpen(false)}
        parentCategoryId={regionType}
        parentCategoryName={categoryName}
        onSuccess={async (categoryId) => {
          await refetchCategories();
          setSelectedSubcategory(categoryId);
          setSelectedRegion(null);
          setAddSubcategoryOpen(false);
        }}
      />
    </div>
  );
}

// ─── Map component ────────────────────────────────────────────────────────────

interface RegionMapProps {
  regions: RegionData[];
  selectedRegion: RegionData | null;
  onRegionClick: (region: RegionData) => void;
}

function RegionMap({ regions, selectedRegion, onRegionClick }: RegionMapProps) {
  // Build a GeoJSON feature collection from all regions
  const featureCollection: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: regions.flatMap((r) =>
      r.geometries
        .map((g) => {
          const geom = parseGeometry(g.geometry);
          if (!geom) return null;
          return {
            type: 'Feature',
            properties: { regionId: r.id, regionName: r.name },
            geometry: geom,
          } as GeoJSON.Feature;
        })
        .filter((f): f is GeoJSON.Feature => f !== null),
    ),
  };

  const style = (feature?: GeoJSON.Feature): L.PathOptions => {
    const isSelected = feature?.properties?.regionId === selectedRegion?.id;
    return {
      color: isSelected ? '#304a91' : '#2563eb',
      weight: isSelected ? 3 : 1.5,
      fillOpacity: isSelected ? 0.35 : 0.15,
      fillColor: isSelected ? '#304a91' : '#2563eb',
    };
  };

  const onEachFeature = (feature: GeoJSON.Feature, layer: L.Layer) => {
    layer.on('click', () => {
      const regionId = feature.properties?.regionId as string;
      const region = regions.find((r) => r.id === regionId);
      if (region) onRegionClick(region);
    });
    if (feature.properties?.regionName) {
      layer.bindTooltip(feature.properties.regionName as string, { sticky: true });
    }
  };

  // Fit bounds to features
  const MapFitter = () => {
    const map = useMapEvents({});
    useEffect(() => {
      if (featureCollection.features.length > 0) {
        try {
          const layer = L.geoJSON(featureCollection);
          const bounds = layer.getBounds();
          if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [20, 20] });
          }
        } catch {
          // ignore invalid geometry
        }
      }
    }, [regions.length]); // eslint-disable-line react-hooks/exhaustive-deps
    return null;
  };

  return (
    <MapContainer
      center={[0, 0]}
      zoom={2}
      style={{ width: '100%', height: '100%' }}
      scrollWheelZoom={false}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <LeafletGeoJSON
        key={`${selectedRegion?.id ?? 'none'}-${regions.length}`}
        data={featureCollection}
        style={style}
        onEachFeature={onEachFeature}
      />
      <MapFitter />
    </MapContainer>
  );
}

// ─── Add subcategory dialog ──────────────────────────────────────────────────

interface AddSubcategoryDialogProps {
  open: boolean;
  onClose: () => void;
  parentCategoryId: string;
  parentCategoryName: string;
  onSuccess: (categoryId: string) => Promise<void>;
}

function AddSubcategoryDialog({
  open,
  onClose,
  parentCategoryId,
  parentCategoryName,
  onSuccess,
}: AddSubcategoryDialogProps) {
  const [name, setName] = useState('');
  const [citation, setCitation] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleClose = () => {
    setName('');
    setCitation('');
    setError('');
    onClose();
  };

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Enter a name for the subcategory.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const created = await createRegionSubcategory({
        parent_category_id: parentCategoryId,
        name: trimmedName,
        ...(citation.trim() ? { citation: citation.trim() } : {}),
      });
      await onSuccess(created.id);
      setName('');
      setCitation('');
    } catch (err) {
      setError(`Could not create subcategory: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add {parentCategoryName} subcategory</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="subcategory-name">Name</Label>
            <Input
              id="subcategory-name"
              value={name}
              maxLength={120}
              placeholder="e.g. Aquifer GAMs"
              onChange={(event) => setName(event.target.value)}
              disabled={loading}
            />
          </div>
          <div>
            <Label htmlFor="subcategory-citation">Citation or source (optional)</Label>
            <Input
              id="subcategory-citation"
              value={citation}
              maxLength={2000}
              placeholder="Optional source or acknowledgement"
              onChange={(event) => setCitation(event.target.value)}
              disabled={loading}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={loading}>
            {loading ? 'Creating…' : 'Create subcategory'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Regions Dialog ───────────────────────────────────────────────────────

interface SubcatItem {
  id: string;
  name: string;
  citation?: string | null;
}

interface AddRegionsDialogProps {
  open: boolean;
  onClose: () => void;
  parentRegionId: string;
  regionType: string;
  subcategories: SubcatItem[];
  activeCategoryId: string;
  canImportRegions: boolean;
  onSuccess: () => void;
}

function AddRegionsDialog({
  open,
  onClose,
  parentRegionId,
  regionType,
  subcategories,
  activeCategoryId,
  canImportRegions,
  onSuccess,
}: AddRegionsDialogProps) {
  const { isAuthenticated } = useAuth();
  const [selectedCategoryId, setSelectedCategoryId] = useState(activeCategoryId);
  const [parsedFeatures, setParsedFeatures] = useState<NewRegionFromGeoJSON[]>([]);
  const [nameProperty, setNameProperty] = useState<string>('');
  const [idProperty, setIdProperty] = useState<string>('');
  const [names, setNames] = useState<string[]>([]);
  const [sourceUrl, setSourceUrl] = useState<string>('');
  const [sourceOptions, setSourceOptions] = useState<RemoteSpatialLayerOption[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [checkedIndices, setCheckedIndices] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !spatialLayersAvailable()) return;
    const controller = new AbortController();
    void fetchSpatialLayers<RemoteSpatialLayerOption>(controller.signal)
      .then((layers) => {
        setSourceOptions(layers);
      })
      .catch(() => {
        // The custom URL field remains usable when the layer catalog is unavailable.
      });
    return () => controller.abort();
  }, [open]);

  const propertyKeys: string[] =
    parsedFeatures.length > 0 && parsedFeatures[0]
      ? Object.keys(parsedFeatures[0].featureProperties)
      : [];

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const geojson = JSON.parse(ev.target?.result as string) as GeoJSON.FeatureCollection;
        if (geojson.type !== 'FeatureCollection') {
          setError('File must be a GeoJSON FeatureCollection');
          return;
        }
        const features = parseGeoJsonFeatures(geojson);
        setParsedFeatures(features);
        setNames(features.map(() => ''));
        setCheckedIndices(new Set(features.map((_, i) => i)));
        setError('');
        setNameProperty('');
        setIdProperty('');
      } catch {
        setError('Invalid JSON file');
      }
    };
    reader.readAsText(file);
  };

  const handleLoadRemoteSource = async () => {
    const uri = sourceUrl.trim();
    if (!uri) {
      setError('Enter a GeoJSON or ArcGIS FeatureServer/MapServer layer URL.');
      return;
    }
    setSourceLoading(true);
    setError('');
    try {
      const response = await fetch(spatialSourceQueryUrl(uri));
      if (!response.ok) throw new Error(`Spatial source returned ${response.status}`);
      const collection = asGeoJsonFeatureCollection(await response.json());
      if (!collection)
        throw new Error('The source did not return a GeoJSON or ArcGIS feature collection.');
      const features = parseGeoJsonFeatures(collection);
      if (features.length === 0) throw new Error('The source returned no geometries.');
      setParsedFeatures(features);
      setNames(features.map(() => ''));
      setCheckedIndices(new Set(features.map((_, i) => i)));
      setNameProperty('');
      setIdProperty('');
    } catch (err) {
      setError(
        `Could not load spatial source: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSourceLoading(false);
    }
  };

  const handleNamePropertyChange = (prop: string) => {
    setNameProperty(prop);
    if (prop) {
      setNames(parsedFeatures.map((f) => String(f.featureProperties[prop] ?? '')));
    }
  };

  const handleToggleAll = (checked: boolean) => {
    if (checked) {
      setCheckedIndices(new Set(parsedFeatures.map((_, i) => i)));
    } else {
      setCheckedIndices(new Set());
    }
  };

  const handleToggle = (i: number) => {
    setCheckedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const handleNameChange = (i: number, value: string) => {
    setNames((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };

  const handleSubmit = async () => {
    if (!isAuthenticated || !canImportRegions) return;
    const selected = [...checkedIndices];
    if (selected.length === 0) {
      setError('Please select at least one region to add.');
      return;
    }
    const missing = selected.filter((i) => !names[i]?.trim());
    if (missing.length > 0) {
      setError(
        'Please enter a name for all selected regions, or select a GeoJSON property to auto-fill names.',
      );
      return;
    }

    const regions = selected.map((i) => {
      const feature = parsedFeatures[i]!;
      const name = names[i] ?? '';
      const sourceId = idProperty ? String(feature.featureProperties[idProperty] ?? '').trim() : '';
      const id = sourceId
        ? `${parentRegionId}__${sourceId.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`
        : generateRegionId(parentRegionId, name);
      return {
        id,
        name: name.trim(),
        geometries: feature.geometries,
      };
    });

    setLoading(true);
    try {
      await importRegions({
        parent_region_id: parentRegionId,
        category_id: selectedCategoryId,
        regions,
      });
    } catch (err) {
      setError(`Error adding regions: ${err instanceof Error ? err.message : String(err)}`);
      return;
    } finally {
      setLoading(false);
    }

    setParsedFeatures([]);
    setNames([]);
    setCheckedIndices(new Set());
    setIdProperty('');
    setSourceUrl('');
    setError('');
    if (fileRef.current) fileRef.current.value = '';
    onSuccess();
  };

  const handleClose = () => {
    setParsedFeatures([]);
    setNames([]);
    setCheckedIndices(new Set());
    setIdProperty('');
    setSourceUrl('');
    setError('');
    if (fileRef.current) fileRef.current.value = '';
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add {regionType} regions</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Category selector */}
          <div>
            <Label htmlFor="category-select">Category</Label>
            <select
              id="category-select"
              className="mt-1 block w-full rounded border border-input bg-background px-3 py-2 text-sm"
              value={selectedCategoryId}
              onChange={(e) => setSelectedCategoryId(e.target.value)}
            >
              <option value={regionType}>Base regions</option>
              {subcategories.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.name}
                </option>
              ))}
            </select>
          </div>

          {/* GeoJSON file upload */}
          <div>
            <Label>GeoJSON File</Label>
            <div className="mt-1">
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.geojson"
                onChange={handleFileChange}
                className="block text-sm"
              />
            </div>
          </div>

          {/* Remote GeoJSON / ArcGIS source */}
          <div className="space-y-1 rounded border bg-muted/30 p-3">
            <Label htmlFor="spatial-source-url">Register from a remote spatial layer</Label>
            <p className="text-xs text-muted-foreground">
              Paste a GeoJSON URL or an ArcGIS FeatureServer/MapServer layer URL. The returned
              features will be copied into MINT regions so the modeling map does not depend on a
              live remote service at selection time.
            </p>
            <div className="flex gap-2">
              <select
                aria-label="Registered spatial source"
                className="min-w-0 flex-1 rounded border border-input bg-background px-3 py-2 text-sm"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
              >
                <option value="">Choose a registered source…</option>
                {sourceOptions.map((source) => (
                  <option key={source.id} value={source.uri}>
                    {source.label}
                  </option>
                ))}
              </select>
              <Input
                id="spatial-source-url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://…/FeatureServer/4"
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleLoadRemoteSource}
                disabled={sourceLoading}
              >
                {sourceLoading ? 'Loading…' : 'Load layer'}
              </Button>
            </div>
          </div>

          {/* Name property selector */}
          {parsedFeatures.length > 0 && propertyKeys.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="name-prop">Auto-fill names from GeoJSON property</Label>
                <select
                  id="name-prop"
                  className="mt-1 block w-full rounded border border-input bg-background px-3 py-2 text-sm"
                  value={nameProperty}
                  onChange={(e) => handleNamePropertyChange(e.target.value)}
                >
                  <option value="">— select property —</option>
                  {propertyKeys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="id-prop">Stable identifier property (optional)</Label>
                <select
                  id="id-prop"
                  className="mt-1 block w-full rounded border border-input bg-background px-3 py-2 text-sm"
                  value={idProperty}
                  onChange={(e) => setIdProperty(e.target.value)}
                >
                  <option value="">— generate stable ID —</option>
                  {propertyKeys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Regions table */}
          {parsedFeatures.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-muted-foreground">
                {parsedFeatures.length} regions found. {checkedIndices.size} selected.
              </p>
              <div className="max-h-64 overflow-auto rounded border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50">
                    <tr>
                      <th className="p-2 text-left">
                        <input
                          type="checkbox"
                          checked={checkedIndices.size === parsedFeatures.length}
                          onChange={(e) => handleToggleAll(e.target.checked)}
                        />
                      </th>
                      <th className="p-2 text-left">Name</th>
                      <th className="p-2 text-left">Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedFeatures.map((feature, i) => (
                      <tr
                        key={i}
                        className={checkedIndices.has(i) ? 'bg-white' : 'bg-gray-50 opacity-50'}
                      >
                        <td className="p-2">
                          <input
                            type="checkbox"
                            checked={checkedIndices.has(i)}
                            onChange={() => handleToggle(i)}
                          />
                        </td>
                        <td className="p-2">
                          <Input
                            value={names[i] ?? ''}
                            onChange={(e) => handleNameChange(i, e.target.value)}
                            placeholder="Region name"
                            className="h-7 text-sm"
                          />
                        </td>
                        <td className="max-w-48 truncate p-2 text-xs text-muted-foreground">
                          {Object.entries(feature.featureProperties)
                            .slice(0, 2)
                            .map(([k, v]) => `${k}: ${v}`)
                            .join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {error && (
            <p className="flex items-center gap-1 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" /> {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              !isAuthenticated ||
              !canImportRegions ||
              loading ||
              parsedFeatures.length === 0 ||
              checkedIndices.size === 0
            }
          >
            {loading
              ? 'Adding…'
              : `Add ${checkedIndices.size} region${checkedIndices.size !== 1 ? 's' : ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
