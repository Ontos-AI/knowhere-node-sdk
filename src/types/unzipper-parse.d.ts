declare module 'unzipper/lib/parse.js' {
  import type { ParseOptions, ParseStream } from 'unzipper';

  const parse: (options?: ParseOptions) => ParseStream;
  export default parse;
}
