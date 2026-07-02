import type {
  DocumentPageCitationSource,
  PageCitationAssetsOptions,
  ParseResult,
} from '../types/index.js';

type PageCitationWorkflowInput = {
  result: ParseResult;
  options: PageCitationAssetsOptions;
  documents: {
    getPageCitationSource(documentId: string): Promise<DocumentPageCitationSource>;
  };
  fallbackDocumentId?: string;
};

type PageCitationWorkflowModule = {
  enrichParseResultWithPageCitationAssets(input: PageCitationWorkflowInput): Promise<ParseResult>;
};

export async function loadPageCitationAssetWorkflow(): Promise<PageCitationWorkflowModule> {
  const sourceLayoutPath: string = './workflow.mjs';
  const bundledLayoutPath: string = './page-citation-assets/workflow.mjs';

  try {
    return await importWorkflowModule(sourceLayoutPath);
  } catch (error) {
    if (!isModuleNotFoundError(error)) {
      throw error;
    }
    return importWorkflowModule(bundledLayoutPath);
  }
}

async function importWorkflowModule(modulePath: string): Promise<PageCitationWorkflowModule> {
  const importedModule: unknown = await import(modulePath);
  if (isPageCitationWorkflowModule(importedModule)) {
    return importedModule;
  }

  throw new Error('Page citation asset workflow module did not expose the expected API');
}

function isPageCitationWorkflowModule(value: unknown): value is PageCitationWorkflowModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'enrichParseResultWithPageCitationAssets' in value &&
    typeof value.enrichParseResultWithPageCitationAssets === 'function'
  );
}

function isModuleNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes('Cannot find module') ||
    error.message.includes('ERR_MODULE_NOT_FOUND') ||
    error.message.includes('Failed to resolve')
  );
}
