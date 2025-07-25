import { Autowired, Injectable } from '@opensumi/di';
import { AppConfig, ILogger } from '@opensumi/ide-core-browser';
import { PreferenceService } from '@opensumi/ide-core-browser/lib/preferences';
import {
  Deferred,
  Disposable,
  Emitter,
  IStorage,
  PreferenceScope,
  STORAGE_NAMESPACE,
  StorageProvider,
  localize,
} from '@opensumi/ide-core-common';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { IMessageService } from '@opensumi/ide-overlay';

import { BUILTIN_MCP_SERVER_NAME, ISumiMCPServerBackend, SumiMCPServerProxyServicePath } from '../../../common';
import {
  MCPServerDescription,
  MCPServersDisabledKey,
  SSEMCPServerDescription,
  StdioMCPServerDescription,
} from '../../../common/mcp-server-manager';
import { MCPServer, MCP_SERVER_TYPE } from '../../../common/types';
import { MCPServerProxyService } from '../mcp-server-proxy.service';

import { MCPServerFormData } from './components/mcp-server-form';

@Injectable()
export class MCPConfigService extends Disposable {
  @Autowired(SumiMCPServerProxyServicePath)
  private readonly sumiMCPServerBackendProxy: ISumiMCPServerBackend;

  @Autowired(MCPServerProxyService)
  private readonly mcpServerProxyService: MCPServerProxyService;

  @Autowired(PreferenceService)
  private readonly preferenceService: PreferenceService;

  @Autowired(IMessageService)
  private readonly messageService: IMessageService;

  @Autowired(StorageProvider)
  private readonly storageProvider: StorageProvider;

  @Autowired(WorkbenchEditorService)
  private readonly workbenchEditorService: WorkbenchEditorService;

  @Autowired(AppConfig)
  private readonly appConfig: AppConfig;

  @Autowired(ILogger)
  private readonly logger: ILogger;

  private chatStorage: IStorage;
  private mcpConfigStorage: IStorage;
  private whenReadyDeferred = new Deferred<void>();

  private _isInitialized = false;
  private disabledToolsCache: Set<string> = new Set();
  private disabledToolsCacheInitialized = false;

  private readonly mcpServersChangeEventEmitter = new Emitter<boolean>();

  constructor() {
    super();

    this.init();
    this.disposables.push(
      this.mcpServerProxyService.onChangeMCPServers(() => {
        this.fireMCPServersChange();
      }),
    );
    this.disposables.push(
      this.preferenceService.onSpecificPreferenceChange('mcp', () => {
        // 通过修改配置增加的 server 需要重新添加到列表中
        this.fireMCPServersChange();
      }),
    );
  }

  private async init() {
    this.chatStorage = await this.storageProvider(STORAGE_NAMESPACE.CHAT);
    this.mcpConfigStorage = await this.storageProvider(STORAGE_NAMESPACE.MCP);
    await this.loadDisabledToolsCache();
    this.whenReadyDeferred.resolve();
  }

  get whenReady() {
    return this.whenReadyDeferred.promise;
  }

  get isInitialized() {
    return this._isInitialized;
  }

  get onMCPServersChange() {
    return this.mcpServersChangeEventEmitter.event;
  }

  fireMCPServersChange(isInit: boolean = false) {
    if (isInit) {
      this._isInitialized = true;
    }
    this.mcpServersChangeEventEmitter.fire(isInit);
  }

  async getServers(): Promise<MCPServer[]> {
    // Get workspace MCP server configurations
    const { value: mcpConfig, scope } = this.preferenceService.resolve<{ mcpServers: Record<string, any> }>(
      'mcp',
      { mcpServers: {} },
      undefined,
    );

    if (scope === PreferenceScope.Default) {
      const runningServers = await this.mcpServerProxyService.$getServers();
      const builtinServer = runningServers.find((server) => server.name === BUILTIN_MCP_SERVER_NAME);
      return builtinServer ? [builtinServer] : [];
    }

    const userServers = Object.keys(mcpConfig!.mcpServers).map((name) => {
      const serverConfig = mcpConfig!.mcpServers[name];
      if (serverConfig.url) {
        return {
          name,
          type: MCP_SERVER_TYPE.SSE,
          url: serverConfig.url,
        };
      }
      return {
        name,
        type: MCP_SERVER_TYPE.STDIO,
        command: serverConfig.command,
        args: serverConfig.args,
        env: serverConfig.env,
      };
    });

    const runningServers = await this.mcpServerProxyService.$getServers();
    const builtinServer = runningServers.find((server) => server.name === BUILTIN_MCP_SERVER_NAME);

    // Merge server configs with running status
    const allServers = userServers?.map((server) => {
      const runningServer = runningServers.find((s) => s.name === server.name);
      if (!runningServer) {
        this.sumiMCPServerBackendProxy.$addOrUpdateServer(server as MCPServerDescription);
      }
      return {
        ...server,
        isStarted: runningServer?.isStarted || false,
        tools: runningServer?.tools || [],
      };
    }) as MCPServer[];

    // Add built-in server at the beginning if it exists
    if (builtinServer) {
      allServers.unshift(builtinServer);
    }

    return allServers;
  }

  async controlServer(serverName: string, start: boolean): Promise<void> {
    try {
      if (start) {
        await this.mcpServerProxyService.$startServer(serverName);
      } else {
        await this.mcpServerProxyService.$stopServer(serverName);
      }

      const disabledMCPServers = this.chatStorage.get<string[]>(MCPServersDisabledKey, []);
      const disabledMCPServersSet = new Set(disabledMCPServers);

      if (start) {
        // 启动时从禁用列表中移除
        disabledMCPServersSet.delete(serverName);
      } else {
        // 停止时添加到禁用列表
        disabledMCPServersSet.add(serverName);
      }
      this.chatStorage.set(MCPServersDisabledKey, Array.from(disabledMCPServersSet));
    } catch (error) {
      const msg = error.message || error;
      this.logger.error(`Failed to ${start ? 'start' : 'stop'} server ${serverName}:`, msg);
      this.messageService.error(msg);
      throw error;
    }
  }

  async saveServer(prev: MCPServerDescription | undefined, data: MCPServerFormData): Promise<void> {
    await this.whenReady;
    const { value: mcpConfig } = this.preferenceService.resolve<{ mcpServers: Record<string, any> }>(
      'mcp',
      { mcpServers: {} },
      undefined,
    );
    const servers = mcpConfig!.mcpServers;

    let serverConfig;
    if (data.type === MCP_SERVER_TYPE.SSE) {
      serverConfig = { url: (data as SSEMCPServerDescription).url };
    } else {
      serverConfig = {
        command: (data as StdioMCPServerDescription).command,
        args: (data as StdioMCPServerDescription).args,
        env: (data as StdioMCPServerDescription).env,
      };
    }
    if (prev?.name) {
      delete servers[prev.name];
    }
    servers[data.name] = serverConfig;
    // 更新情况下，如果原有服务是启用状态，则进行如下操作：
    // 1. 关闭旧的服务
    // 2. 启动新的服务
    await this.preferenceService.set('mcp', { mcpServers: servers });
    if (prev?.enabled) {
      this.sumiMCPServerBackendProxy.$removeServer(prev.name);
    }
    this.sumiMCPServerBackendProxy.$addOrUpdateServer(data as MCPServerDescription);
  }

  async deleteServer(serverName: string): Promise<void> {
    const { value: mcpConfig } = this.preferenceService.resolve<{ mcpServers: Record<string, any> }>(
      'mcp',
      { mcpServers: {} },
      undefined,
    );
    const servers = mcpConfig!.mcpServers;
    if (servers[serverName]) {
      delete servers[serverName];
      await this.sumiMCPServerBackendProxy.$removeServer(serverName);
      await this.preferenceService.set('mcp', { mcpServers: servers });
    }
  }

  async syncServer(serverName: string): Promise<void> {
    try {
      await this.sumiMCPServerBackendProxy.$syncServer(serverName);
    } catch (error) {
      this.logger.error(`Failed to sync server ${serverName}:`, error);
      this.messageService.error(error.message || error);
    }
  }

  async getServerConfigByName(serverName: string): Promise<MCPServerDescription | undefined> {
    const { value: mcpConfig } = this.preferenceService.resolve<{ mcpServers: Record<string, any> }>(
      'mcp',
      { mcpServers: {} },
      undefined,
    );
    await this.whenReady;
    const disabledMCPServers = this.chatStorage.get<string[]>(MCPServersDisabledKey, []);
    const server = mcpConfig!.mcpServers[serverName];
    if (server) {
      if (server.url) {
        return {
          name: serverName,
          type: MCP_SERVER_TYPE.SSE,
          url: server.url,
          enabled: !disabledMCPServers.includes(serverName),
        };
      } else {
        return {
          name: serverName,
          type: MCP_SERVER_TYPE.STDIO,
          command: server.command,
          args: server.args,
          env: Object.assign({ cwd: this.appConfig.workspaceDir }, server.env),
          enabled: !disabledMCPServers.includes(serverName),
        };
      }
    }
    return undefined;
  }

  getReadableServerType(type: string): string {
    switch (type) {
      case MCP_SERVER_TYPE.STDIO:
        return localize('ai.native.mcp.type.stdio');
      case MCP_SERVER_TYPE.SSE:
        return localize('ai.native.mcp.type.sse');
      case MCP_SERVER_TYPE.BUILTIN:
        return localize('ai.native.mcp.type.builtin');
      default:
        return type;
    }
  }

  async getDisabledTools(): Promise<string[]> {
    await this.whenReady;
    if (!this.disabledToolsCacheInitialized) {
      await this.loadDisabledToolsCache();
    }
    return Array.from(this.disabledToolsCache);
  }

  async toggleToolEnabled(toolName: string): Promise<void> {
    await this.whenReady;
    if (!this.disabledToolsCacheInitialized) {
      await this.loadDisabledToolsCache();
    }

    if (this.disabledToolsCache.has(toolName)) {
      this.disabledToolsCache.delete(toolName);
    } else {
      this.disabledToolsCache.add(toolName);
    }

    await this.mcpConfigStorage.set('disabledMCPTools', Array.from(this.disabledToolsCache));
  }

  async isToolEnabled(toolName: string): Promise<boolean> {
    await this.whenReady;
    if (!this.disabledToolsCacheInitialized) {
      await this.loadDisabledToolsCache();
    }
    return !this.disabledToolsCache.has(toolName);
  }

  async openConfigFile(): Promise<void> {
    let config = this.preferenceService.resolve<{ mcpServers: Record<string, any> }>(
      'mcp',
      { mcpServers: {} },
      undefined,
    );
    if (config.scope === PreferenceScope.Default) {
      await this.preferenceService.set('mcp', { mcpServers: {} }, PreferenceScope.Workspace);
      config = this.preferenceService.resolve<{ mcpServers: Record<string, any> }>(
        'mcp',
        { mcpServers: {} },
        undefined,
      );
    }
    const uri = config.configUri;
    if (uri) {
      this.workbenchEditorService.open(uri, {
        preview: false,
      });
    }
  }

  private async loadDisabledToolsCache(): Promise<void> {
    const disabledTools = this.mcpConfigStorage.get<string[]>('disabledMCPTools', []);
    this.disabledToolsCache = new Set(disabledTools);
    this.disabledToolsCacheInitialized = true;
  }
}
