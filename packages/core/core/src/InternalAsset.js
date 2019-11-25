// @flow strict-local

import type {
  AST,
  ASTGenerator,
  Blob,
  ConfigResult,
  DependencyOptions,
  File,
  FilePath,
  Meta,
  PackageJSON,
  PackageName,
  Stats,
  Symbol,
  Transformer,
  TransformerResult
} from '@parcel/types';
import type {Asset, Dependency, Environment, ParcelOptions} from './types';

import {Readable} from 'stream';
import SourceMap from '@parcel/source-map';
import {
  bufferStream,
  loadConfig,
  md5FromString,
  blobToStream,
  streamFromPromise,
  fallbackStream,
  TapStream
} from '@parcel/utils';
import nullthrows from 'nullthrows';
import {createDependency, mergeDependencies} from './Dependency';
import {mergeEnvironments, getEnvironmentHash} from './Environment';
import {PARCEL_VERSION} from './constants';
import loadPlugin from './loadParcelPlugin';
import PluginOptions from './public/PluginOptions';
import {Asset as PublicAsset} from './public/Asset';
import {PluginLogger} from '@parcel/logger';

type AssetOptions = {|
  id?: string,
  hash?: ?string,
  idBase?: ?string,
  filePath: FilePath,
  type: string,
  contentKey?: ?string,
  mapKey?: ?string,
  astKey?: ?string,
  astGenerator?: ?ASTGenerator,
  dependencies?: Map<string, Dependency>,
  includedFiles?: Map<FilePath, File>,
  isIsolated?: boolean,
  isInline?: boolean,
  isSource: boolean,
  env: Environment,
  meta?: Meta,
  pipeline?: ?string,
  stats: Stats,
  symbols?: Map<Symbol, Symbol>,
  sideEffects?: boolean,
  uniqueKey?: ?string,
  plugin?: PackageName,
  configPath?: FilePath
|};

export function createAsset(options: AssetOptions): Asset {
  let idBase = options.idBase != null ? options.idBase : options.filePath;
  let uniqueKey = options.uniqueKey || '';
  return {
    id:
      options.id != null
        ? options.id
        : md5FromString(
            idBase + options.type + getEnvironmentHash(options.env) + uniqueKey
          ),
    hash: options.hash,
    filePath: options.filePath,
    isIsolated: options.isIsolated == null ? false : options.isIsolated,
    isInline: options.isInline == null ? false : options.isInline,
    type: options.type,
    contentKey: options.contentKey,
    mapKey: options.mapKey,
    astKey: options.astKey,
    astGenerator: options.astGenerator,
    dependencies: options.dependencies || new Map(),
    includedFiles: options.includedFiles || new Map(),
    isSource: options.isSource,
    pipeline: options.pipeline,
    env: options.env,
    meta: options.meta || {},
    stats: options.stats,
    symbols: options.symbols || new Map(),
    sideEffects: options.sideEffects != null ? options.sideEffects : true,
    uniqueKey: uniqueKey,
    plugin: options.plugin,
    configPath: options.configPath
  };
}

type InternalAssetOptions = {|
  value: Asset,
  options: ParcelOptions,
  content?: ?Blob,
  map?: ?SourceMap,
  ast?: ?AST,
  isASTDirty?: ?boolean,
  idBase?: ?string
|};

export default class InternalAsset {
  value: Asset;
  options: ParcelOptions;
  content: ?Blob;
  map: ?SourceMap;
  ast: ?AST;
  isASTDirty: boolean;
  idBase: ?string;
  isGenerating: boolean;

  constructor({
    value,
    options,
    content,
    map,
    ast,
    isASTDirty,
    idBase
  }: InternalAssetOptions) {
    this.value = value;
    this.options = options;
    this.content = content;
    this.map = map;
    this.ast = ast;
    this.isASTDirty = isASTDirty || false;
    this.idBase = idBase;
    this.isGenerating = false;
  }

  /*
   * Prepares the asset for being serialized to the cache by commiting its
   * content and map of the asset to the cache.
   */
  async commit(pipelineKey: string): Promise<void> {
    let contentStream = this.getStream();
    if (
      // $FlowFixMe
      typeof contentStream.bytesRead === 'number' &&
      // If the amount of data read from this stream so far isn't exactly the amount
      // of data that is available to be read, then it has been read from.
      contentStream.bytesRead !== contentStream.readableLength
    ) {
      throw new Error(
        'Stream has already been read. This may happen if a plugin reads from a stream and does not replace it.'
      );
    }

    let size = 0;
    let contentKey = this.getCacheKey('content' + pipelineKey);
    let mapKey = this.getCacheKey('map' + pipelineKey);
    let astKey =
      this.ast == null ? null : this.getCacheKey('ast' + pipelineKey);

    // Since we can only read from the stream once, compute the content length
    // and hash while it's being written to the cache.
    await Promise.all([
      this.content == null
        ? Promise.resolve()
        : this.options.cache.setStream(
            contentKey,
            contentStream.pipe(
              new TapStream(buf => {
                size += buf.length;
              })
            )
          ),
      this.map == null
        ? Promise.resolve()
        : this.options.cache.set(mapKey, this.map),
      astKey == null
        ? Promise.resolve()
        : this.options.cache.set(astKey, this.ast)
    ]);
    this.value.contentKey = contentKey;
    this.value.mapKey = mapKey;
    this.value.astKey = astKey;

    // TODO: how should we set the size when we only store an AST?
    if (this.content != null) {
      this.value.stats.size = size;
    }
  }

  async generateFromAST() {
    if (this.isGenerating) {
      throw new Error('Cannot call asset.getCode() from while generating');
    }

    this.isGenerating = true;

    let ast = await this.getAST();
    if (ast == null) {
      throw new Error('Asset has no AST');
    }

    let pluginName = nullthrows(this.value.plugin);
    let plugin: Transformer = await loadPlugin(
      this.options.packageManager,
      pluginName,
      nullthrows(this.value.configPath)
    );
    if (!plugin.generate) {
      throw new Error(`${pluginName} does not have a generate method`);
    }

    let {code, map} = await plugin.generate({
      asset: new PublicAsset(this),
      ast,
      options: new PluginOptions(this.options),
      logger: new PluginLogger({origin: pluginName})
    });

    this.content = code;
    this.map = map;

    // Store the results in the cache so we can avoid generating again next time
    await Promise.all([
      this.options.cache.setStream(
        nullthrows(this.value.contentKey),
        this.getStream()
      ),
      this.map == null
        ? Promise.resolve()
        : this.options.cache.set(nullthrows(this.value.mapKey), this.map)
    ]);

    this.isGenerating = false;
    return this.content || '';
  }

  ensureContent() {
    let contentKey = this.value.contentKey;
    if (contentKey != null && this.content == null) {
      // First try the contentKey, and if it doesn't exist, fall back to generating from AST
      this.content = fallbackStream(
        this.options.cache.getStream(contentKey),
        () => streamFromPromise(this.generateFromAST())
      );
    }
  }

  async getCode(): Promise<string> {
    this.ensureContent();

    if (typeof this.content === 'string' || this.content instanceof Buffer) {
      this.content = this.content.toString();
    } else if (this.content != null) {
      this.content = (await bufferStream(this.content)).toString();
    }

    return this.content || '';
  }

  async getBuffer(): Promise<Buffer> {
    this.ensureContent();

    if (this.content == null) {
      return Buffer.alloc(0);
    } else if (
      typeof this.content === 'string' ||
      this.content instanceof Buffer
    ) {
      return Buffer.from(this.content);
    }

    this.content = await bufferStream(this.content);
    return this.content;
  }

  getStream(): Readable {
    this.ensureContent();
    return blobToStream(this.content != null ? this.content : Buffer.alloc(0));
  }

  setCode(code: string) {
    this.content = code;
    this.clearAST();
  }

  setBuffer(buffer: Buffer) {
    this.content = buffer;
    this.clearAST();
  }

  setStream(stream: Readable) {
    this.content = stream;
    this.clearAST();
  }

  async getMap(): Promise<?SourceMap> {
    if (this.value.mapKey != null && this.map == null) {
      try {
        this.map = await this.options.cache.get(this.value.mapKey);
      } catch (err) {
        if (err.code === 'ENOENT' && this.value.astKey != null) {
          await this.generateFromAST();
        } else {
          throw err;
        }
      }
    }

    return this.map;
  }

  setMap(map: ?SourceMap): void {
    this.map = map;
  }

  async getAST(): Promise<?AST> {
    if (this.value.astKey != null) {
      this.ast = await this.options.cache.get(this.value.astKey);
    }

    return this.ast;
  }

  setAST(ast: AST): void {
    this.ast = ast;
    this.isASTDirty = true;
    this.value.astGenerator = {
      type: ast.type,
      version: ast.version
    };

    this.content = null;
    this.map = null;
  }

  clearAST() {
    this.ast = null;
    this.isASTDirty = false;
    this.value.astGenerator = null;
  }

  getCacheKey(key: string): string {
    return md5FromString(
      PARCEL_VERSION + key + this.value.id + (this.value.hash || '')
    );
  }

  addDependency(opts: DependencyOptions) {
    // eslint-disable-next-line no-unused-vars
    let {env, target, ...rest} = opts;
    let dep = createDependency({
      ...rest,
      env: mergeEnvironments(this.value.env, env),
      sourceAssetId: this.value.id,
      sourcePath: this.value.filePath
    });
    let existing = this.value.dependencies.get(dep.id);
    if (existing) {
      mergeDependencies(existing, dep);
    } else {
      this.value.dependencies.set(dep.id, dep);
    }
    return dep.id;
  }

  addIncludedFile(file: File) {
    this.value.includedFiles.set(file.filePath, file);
  }

  getIncludedFiles(): Array<File> {
    return Array.from(this.value.includedFiles.values());
  }

  getDependencies(): Array<Dependency> {
    return Array.from(this.value.dependencies.values());
  }

  createChildAsset(
    result: TransformerResult,
    plugin: PackageName,
    configPath: FilePath
  ): InternalAsset {
    let content = result.content ?? result.code ?? null;

    let asset = new InternalAsset({
      value: createAsset({
        idBase: this.idBase,
        hash: this.value.hash,
        filePath: this.value.filePath,
        type: result.type,
        isIsolated: result.isIsolated ?? this.value.isIsolated,
        isInline: result.isInline ?? this.value.isInline,
        isSource: result.isSource ?? this.value.isSource,
        env: mergeEnvironments(this.value.env, result.env),
        dependencies:
          this.value.type === result.type
            ? new Map(this.value.dependencies)
            : new Map(),
        includedFiles: new Map(this.value.includedFiles),
        meta: {
          ...this.value.meta,
          // $FlowFixMe
          ...result.meta
        },
        pipeline:
          result.pipeline ??
          (this.value.type === result.type ? this.value.pipeline : null),
        stats: {
          time: 0,
          size: this.value.stats.size
        },
        symbols: new Map([...this.value.symbols, ...(result.symbols || [])]),
        sideEffects: result.sideEffects ?? this.value.sideEffects,
        uniqueKey: result.uniqueKey,
        astGenerator: result.ast
          ? {type: result.ast.type, version: result.ast.version}
          : null,
        plugin,
        configPath
      }),
      options: this.options,
      content,
      ast: result.ast,
      isASTDirty: result.ast === this.ast ? this.isASTDirty : true,
      map: result.map,
      idBase: this.idBase
    });

    let dependencies = result.dependencies;
    if (dependencies) {
      for (let dep of dependencies) {
        asset.addDependency(dep);
      }
    }

    let includedFiles = result.includedFiles;
    if (includedFiles) {
      for (let file of includedFiles) {
        asset.addIncludedFile(file);
      }
    }

    return asset;
  }

  async getConfig(
    filePaths: Array<FilePath>,
    options: ?{|
      packageKey?: string,
      parse?: boolean
    |}
  ): Promise<ConfigResult | null> {
    let packageKey = options?.packageKey;
    let parse = options && options.parse;

    if (packageKey != null) {
      let pkg = await this.getPackage();
      if (pkg && pkg[packageKey]) {
        return pkg[packageKey];
      }
    }

    let conf = await loadConfig(
      this.options.inputFS,
      this.value.filePath,
      filePaths,
      parse == null ? null : {parse}
    );
    if (!conf) {
      return null;
    }

    for (let file of conf.files) {
      this.addIncludedFile(file);
    }

    return conf.config;
  }

  getPackage(): Promise<PackageJSON | null> {
    return this.getConfig(['package.json']);
  }
}
