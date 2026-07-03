export type PageCitationAssetContentType = 'image/png' | 'image/jpeg';

export type PageCitationAssetSource =
  | 'knowhere-rendered-page-citation-source'
  | 'client-rendered-page-citation-source';

export interface PageCitationAsset {
  pageNum: number;
  artifactRef: string;
  assetUrl?: string;
  contentType: PageCitationAssetContentType;
  width?: number;
  height?: number;
  source: PageCitationAssetSource;
}
