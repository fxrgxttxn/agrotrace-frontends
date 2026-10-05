export interface AssetVariant {
  url: string;
  sha256: string;
  size: number;
}

export interface RasterAsset {
  mime: string;
  size: number;
  sha256: string;
  variants: Record<96 | 480, AssetVariant>;
}

export interface SeedImages {
  products: Record<string, RasterAsset>;
  avatars: Record<string, RasterAsset>;
  logos: Record<string, AssetVariant>;
}
