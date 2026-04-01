export interface IWebSearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface IWebSearchService {
  search(params: { query: string; maxResults: number }): Promise<IWebSearchResult[]>;
}
