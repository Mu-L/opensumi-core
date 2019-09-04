import { observable, runInAction, action } from 'mobx';
import { Injectable, Autowired } from '@ali/common-di';
import {
  WithEventBus,
  CommandService,
  IContextKeyService,
  URI,
  IDisposable,
  isWindows,
  EDITOR_COMMANDS,
} from '@ali/ide-core-browser';
import { FileTreeAPI, IFileTreeItem, IFileTreeItemStatus } from '../common';
import { AppConfig, Emitter } from '@ali/ide-core-browser';
import { IFileServiceClient, FileChange, FileChangeType, IFileServiceWatcher } from '@ali/ide-file-service/lib/common';
import { TEMP_FILE_NAME } from '@ali/ide-core-browser/lib/components';
import { IFileTreeItemRendered } from './file-tree.view';
import { IWorkspaceService } from '@ali/ide-workspace';
import { FileStat } from '@ali/ide-file-service';
import { IDecorationsService, IResourceDecorationChangeEvent } from '@ali/ide-decoration';

// windows下路径查找时分隔符为 \
export const FILE_SLASH_FLAG = isWindows ? '\\' : '/';

export interface IFileTreeServiceProps {
  onSelect: (files: IFileTreeItem[]) => void;
  onDragStart: (node: IFileTreeItemRendered, event: React.DragEvent) => void;
  onDragOver: (node: IFileTreeItemRendered, event: React.DragEvent) => void;
  onDragEnter: (node: IFileTreeItemRendered, event: React.DragEvent) => void;
  onDragLeave: (node: IFileTreeItemRendered, event: React.DragEvent) => void;
  onDrop: (node: IFileTreeItemRendered, event: React.DragEvent) => void;
  onContextMenu: (nodes: IFileTreeItemRendered[], event: React.MouseEvent<HTMLElement>) => void;
  onChange: (node: IFileTreeItemRendered, value: string) => void;
  draggable: boolean;
  editable: boolean;
}

export interface IWorkspaceRoot {
  uri: string;
  isDirectory: boolean;
  lastModification?: number;
}

export type IWorkspaceRoots = IWorkspaceRoot[];

@Injectable()
export class FileTreeService extends WithEventBus {

  static WAITING_PERIOD = 100;
  @observable.shallow
  files: IFileTreeItem[] = [];

  @observable.shallow
  status: IFileTreeItemStatus = {};

  private _root: FileStat | undefined;

  private fileServiceWatchers: {
    [uri: string]: IFileServiceWatcher,
  } = {};

  @Autowired(AppConfig)
  private config: AppConfig;

  @Autowired()
  private fileAPI: FileTreeAPI;

  @Autowired(CommandService)
  private commandService: CommandService;

  @Autowired(IFileServiceClient)
  private fileServiceClient: IFileServiceClient;

  @Autowired(IContextKeyService)
  contextKeyService: IContextKeyService;

  @Autowired(IWorkspaceService)
  workspaceService: IWorkspaceService;

  @Autowired(IDecorationsService)
  decorationsService: IDecorationsService;

  private decorationsChanged = new Emitter<IResourceDecorationChangeEvent>();

  get onDecorationsChanged() {
    return this.decorationsChanged.event;
  }

  constructor(
  ) {
    super();
    this.init();
  }

  async init() {
    this.fileServiceClient.onFilesChanged((files: FileChange[]) => {
      runInAction(async () => {
        for (const file of files) {
          let parent: IFileTreeItem;
          let parentFolder: string;
          switch (file.type) {
            case (FileChangeType.UPDATED):
            break;
            case (FileChangeType.ADDED):
              // 表示已存在相同文件，不新增文件
              if (this.status[file.uri.toString()]) {
                break;
              }
              parentFolder = this.getFileParent(file.uri, (path: string) => {
                if (this.status[path] && this.status[path].file && this.status[path].file!.filestat.isDirectory) {
                  return true;
                } else {
                  return false;
                }
              });
              // 父节点还未引入，不更新
              if (!this.status[parentFolder]) {
                break;
              }
              parent = this.status[parentFolder].file as IFileTreeItem;
              // 父节点文件不存在或者已引入，待更新
              if (!parent) {
                break;
              }
              // 当父节点为未展开状态时，标记其父节点待更新，处理下个文件
              if (!this.status[parentFolder].expanded) {
                this.status[parentFolder] = {
                  ...this.status[parentFolder],
                  needUpdated: true,
                };
                break;
              }
              const filestat = await this.fileAPI.getFileStat(file.uri);
              if (!filestat) {
                // 文件不存在，直接结束
                return;
              }
              const target: IFileTreeItem = this.fileAPI.generatorFileFromFilestat(filestat, parent);
              if (target.filestat.isDirectory) {
                this.status[file.uri.toString()] = {
                  selected: false,
                  focused: false,
                  expanded: false,
                  needUpdated: true,
                  file: target,
                };
              } else {
                this.status[file.uri.toString()] = {
                  selected: false,
                  focused: false,
                  file: target,
                };
              }
              parent.children.push(target);
              parent.children = this.fileAPI.sortByNumberic(parent.children);
              this.status[parentFolder] = {
                ...this.status[parentFolder],
                file: parent,
              };
              break;
            case (FileChangeType.DELETED):
              parent = this.status[file.uri] && this.status[file.uri].file!.parent as IFileTreeItem;
              if (!parent) {
                break;
              }
              parentFolder = parent.uri.toString();
              // 当父节点为未展开状态时，标记其父节点待更新，处理下个文件
              if (!this.status[parentFolder].expanded) {
                this.status[parentFolder] = {
                  ...this.status[parentFolder],
                  needUpdated: true,
                };
                break;
              }
              for (let i = parent.children.length - 1; i >= 0; i--) {
                if (parent.children[i].uri.toString() === file.uri) {
                  runInAction(() => {
                    parent.children.splice(i, 1);
                    delete this.status[file.uri];
                  });
                  break;
                }
              }
              break;
            default:
              break;
          }
        }
      });
    });
    this.decorationsService.onDidChangeDecorations((e: IResourceDecorationChangeEvent) => {
      this.decorationsChanged.fire(e);
    });
    const roots: IWorkspaceRoots = await this.workspaceService.roots;

    this._root = this.workspaceService.workspace;
    await this.getFiles(roots);

    this.workspaceService.onWorkspaceChanged(async (workspace: FileStat[]) => {
      this._root = this.workspaceService.workspace;
      this.dispose();
      await this.getFiles(workspace);
    });
  }

  dispose() {
    for (const watcher of Object.keys(this.fileServiceWatchers)) {
      this.fileServiceWatchers[watcher].dispose();
    }
  }

  get isFocused(): boolean {
    for (const uri of Object.keys(this.status)) {
      if (this.status[uri].focused) {
        return true;
      }
    }
    return false;
  }

  get isSelected(): boolean {
    for (const uri of Object.keys(this.status)) {
      if (this.status[uri].selected) {
        return true;
      }
    }
    return false;
  }

  get isMutiWorkspace(): boolean {
    return !!this.workspaceService.workspace && !this.workspaceService.workspace.isDirectory;
  }

  get root(): URI {
    if (this._root) {
      return new URI(this._root.uri);
    }
    return new URI().withPath(this.config.workspaceDir).withScheme('file');
  }

  get focusedFiles(): IFileTreeItem[] {
    const focused: IFileTreeItem[] = [];
    for (const uri of Object.keys(this.status)) {
      if (this.status[uri].focused) {
        focused.push(this.status[uri].file);
      }
    }
    return focused;
  }

  getStatutsKey(file: IFileTreeItem) {
    // 为软链接文件添加标记
    return file.filestat.uri + (file.filestat.isSymbolicLink ? '#' : '');
  }

  getParent(uri: URI) {
    if (this.status[uri.toString()]) {
      return this.status[uri.toString()].file.parent;
    }
  }

  getChildren(uri: URI) {
    if (this.status[uri.toString()]) {
      return this.status[uri.toString()].file.children;
    }
  }

  getSelectedFileItem(): URI[] {
    const result: URI[] = Object.keys(this.status).filter((uri) => {
      return this.status[uri].selected;
    }).map((uri) => {
      return this.status[uri].file.uri;
    });
    return result;
  }

  @action
  async createFile(node: IFileTreeItem, newName: string) {
    const uri = node.uri.toString();
    this.removeStatusAndFileFromParent(uri);
    if (newName === TEMP_FILE_NAME) {
      return ;
    }
    const exist = await this.fileAPI.exists(uri);
    if (!exist) {
      await this.fileAPI.createFile(this.replaceFileName(uri, newName));
    }
  }

  @action
  async createFolder(node: IFileTreeItem, newName: string) {
    const uri = node.uri.toString();
    this.removeStatusAndFileFromParent(uri);
    if (newName === TEMP_FILE_NAME) {
      return ;
    }
    const exist = await this.fileAPI.exists(uri);
    if (!exist) {
      await this.fileAPI.createFolder(this.replaceFileName(uri, newName));
    }
  }

  /**
   * 从status及files里移除资源
   * @param uri
   */
  @action
  removeStatusAndFileFromParent(uri: string) {
    const parent = this.status[uri] && this.status[uri].file!.parent as IFileTreeItem;
    if (parent) {
      const parentFolder = this.getStatutsKey(parent);
      // 当父节点为未展开状态时，标记其父节点待更新，处理下个文件
      if (!this.status[parentFolder].expanded) {
        this.status[parentFolder] = {
          ...this.status[parentFolder],
          needUpdated: true,
        };
      }
      for (let i = parent.children.length - 1; i >= 0; i--) {
        const child = this.getStatutsKey(parent.children[i]);
        if (child === uri) {
          runInAction(() => {
            parent.children.splice(i, 1);
            delete this.status[uri];
          });
          break;
        }
      }
    }
  }

  @action
  removeTempStatus() {
    for (const key of Object.keys(this.status)) {
      if (this.status[key] && this.status[key].file && this.status[key].file.name === TEMP_FILE_NAME) {
        this.removeStatusAndFileFromParent(this.status[key].file.filestat.uri);
        break;
      }
    }
  }

  /**
   * 创建临时文件
   * @param uri
   */
  @action
  async createTempFile(uri: string): Promise<URI | void> {
    const parentFolder = this.searchFileParent(uri, (path: string) => {
      if (this.status[path] && this.status[path].file && this.status[path].file!.filestat.isDirectory) {
        return true;
      } else {
        return false;
      }
    });
    if (!parentFolder) {
      return ;
    }
    const tempFileName = `${parentFolder}${FILE_SLASH_FLAG}${TEMP_FILE_NAME}`;
    const parent = this.status[parentFolder].file;
    const tempfile: IFileTreeItem = this.fileAPI.generatorTempFile(tempFileName, parent);
    const target = this.status[uri];
    if (target.file.filestat.isDirectory && !target.expanded) {
      await this.updateFilesExpandedStatus(target.file);
    }
    if (this.status[tempFileName]) {
      return ;
    }
    this.status[tempFileName] = {
      selected: false,
      focused: false,
      file: tempfile,
    };
    parent.children.push(tempfile);
    parent.children = this.fileAPI.sortByNumberic(parent.children);
    this.status[parentFolder] = {
      ...this.status[parentFolder],
      file: parent,
    };
    return tempfile.uri;
  }

  /**
   * 创建临时文件夹
   * @param uri
   */
  @action
  async createTempFolder(uri: string): Promise<URI | void> {
    const parentFolder = this.searchFileParent(uri, (path: string) => {
      if (this.status[path] && this.status[path].file && this.status[path].file!.filestat.isDirectory) {
        return true;
      } else {
        return false;
      }
    });
    if (!parentFolder) {
      return ;
    }
    const tempFileName = `${parentFolder}${FILE_SLASH_FLAG}${TEMP_FILE_NAME}`;
    const parent = this.status[parentFolder].file;
    const tempfile: IFileTreeItem = this.fileAPI.generatorTempFolder(tempFileName, parent);
    const target = this.status[uri];
    if (target.file.filestat.isDirectory && !target.expanded) {
      await this.updateFilesExpandedStatus(target.file);
    }
    if (this.status[tempFileName]) {
      return ;
    }
    this.status[tempFileName] = {
      selected: false,
      focused: false,
      file: tempfile,
    };
    parent.children.push(tempfile);
    parent.children = this.fileAPI.sortByNumberic(parent.children);
    this.status[parentFolder] = {
      ...this.status[parentFolder],
      file: parent,
    };
    return tempfile.uri;
  }

  /**
   * 创建临时文件用于重命名
   * @param uri
   */
  @action
  async renameTempFile(uri: URI) {
    this.status[uri.toString()] = {
      ...this.status[uri.toString()],
      file: {
        ...this.status[uri.toString()].file,
        filestat: {
          ...this.status[uri.toString()].file.filestat,
        isTemporaryFile: true,
        },
      },
    };
  }

  async renameFile(node: IFileTreeItem, value: string) {
    if (value && value !== node.name) {
      await this.fileAPI.moveFile(node.filestat.uri, this.replaceFileName(node.filestat.uri, value));
    }
    const uri = this.getStatutsKey(node);
    if (!this.status[uri]) {
      return;
    }

    this.status[uri] = {
      ... this.status[uri],
      file: {
        ...this.status[uri].file,
        filestat: {
          ...this.status[uri].file.filestat,
          isTemporaryFile: false,
        },
      },
    };
  }

  async deleteFile(uri: URI) {
    await this.fileAPI.deleteFile(uri);
  }

  async moveFile(from: string, targetDir: string) {
    const sourcePieces = from.split(FILE_SLASH_FLAG);
    const sourceName = sourcePieces[sourcePieces.length - 1];
    const to = `${targetDir}${FILE_SLASH_FLAG}${sourceName}`;
    this.resetFilesSelectedStatus();
    if (from === to) {
      this.status[to] = {
        ...this.status[to],
        focused: true,
      };
      // 路径相同，不处理
      return ;
    }
    if (this.status[to]) {
      // 如果已存在该文件，提示是否替换文件
      const replace = confirm(`是否替换文件${sourceName}`);
      if (replace) {
        await this.fileAPI.moveFile(from, to);
        this.status[to] = {
          ...this.status[to],
          focused: true,
        };
      }
    } else {
      await this.fileAPI.moveFile(from, to);
    }
  }

  async deleteFiles(uris: URI[]) {
    uris.forEach(async (uri: URI) => {
      await this.fileAPI.deleteFile(uri);
    });
  }

  /**
   * 折叠所有节点
   */
  @action
  collapseAll(uri?: URI) {
    if (!uri) {
      for (const uri of Object.keys(this.status)) {
        this.status[uri] = {
          ...this.status[uri],
          expanded: false,
        };
      }
    } else {
      const path = uri.toString();
      const children = this.status[path].file.children;
      if (children && children.length > 0) {
        children.forEach((child) => {
          if (child.filestat.isDirectory) {
            const childPath = child.uri.toString();
            this.status[childPath] = {
              ...this.status[childPath],
              expanded: false,
              needUpdated: true,
            };
          }
        });
      }
    }
  }

  /**
   * 刷新所有节点
   */
  @action
  refreshAll(uri: URI) {
    const path = uri.toString();
    if (!this.status[path]) {
      return;
    }
    if (this.status[path].file.filestat.isDirectory) {
      this.status[path] = {
        ...this.status[path],
        needUpdated: true,
      };
      if (this.status[path].expanded) {
        this.refreshExpandedFile(this.status[path].file);
      }
    }
    const children = this.status[path].file.children;
    if (children && children.length > 0) {
      children.forEach((child) => {
        const childPath = child.uri.toString();
        if (child.filestat.isDirectory) {
          if (!this.status[childPath]) {
            return;
          }
          if (this.status[childPath].expanded) {
            this.refreshAll(child.uri);
          } else {
            this.status[childPath] = {
              ...this.status[childPath],
              needUpdated: true,
            };
          }
        }
      });
    }
  }

  searchFileParent(uri: string, check: any) {
    const uriPathArray = uri.split(FILE_SLASH_FLAG);
    let len = uriPathArray.length;
    let parent;
    while ( len ) {
      parent = uriPathArray.slice(0, len).join(FILE_SLASH_FLAG);
      if (check(parent)) {
        return parent;
      }
      len--;
    }
    return false;
  }

  replaceFileName(uri: string, name: string) {
    const uriPathArray = uri.split(FILE_SLASH_FLAG);
    uriPathArray.pop();
    uriPathArray.push(name);
    return uriPathArray.join(FILE_SLASH_FLAG);
  }

  getFileParent(uri: string, check: any) {
    const uriPathArray = uri.split(FILE_SLASH_FLAG);
    const len = uriPathArray.length;
    let parent;
    parent = uriPathArray.slice(0, len - 1).join(FILE_SLASH_FLAG);
    if (check(parent)) {
      return parent;
    }
    return false;
  }

  /**
   * 当选中事件激活时同时也为焦点事件
   * 需要同时设置seleted与focused
   * @param file
   * @param value
   */
  @action
  updateFilesSelectedStatus(files: IFileTreeItem[], value: boolean) {
    if (files.length === 0) {
      this.resetFilesFocusedStatus();
    } else {
      this.resetFilesSelectedStatus();
      files.forEach((file: IFileTreeItem) => {
        const uri = this.getStatutsKey(file);
        this.status[uri] = {
          ...this.status[uri],
          selected: value,
          focused: value,
        };
      });
    }
  }

  /**
   * 重置所有文件Selected属性
   */
  @action
  resetFilesSelectedStatus() {
    const uris = Object.keys(this.status);
    for (const i of uris) {
      this.status[i] = {
        ...this.status[i],
        selected: false,
        focused: false,
      };
    }
  }

  /**
   * 焦点事件与选中事件不冲突，可同时存在
   * 选中为A，焦点为B的情况
   * @param file
   * @param value
   */
  @action
  updateFilesFocusedStatus(files: IFileTreeItem[], value: boolean) {
    this.resetFilesFocusedStatus();
    files.forEach((file: IFileTreeItem) => {
      const uri = this.getStatutsKey(file);
      this.status[uri] = {
        ...this.status[uri],
        focused: value,
      };
    });
  }

  /**
   * 重置所有文件Focused属性
   */
  @action
  resetFilesFocusedStatus() {
    const uris = Object.keys(this.status);
    for (const i of uris) {
      this.status[i] = {
        ...this.status[i],
        focused: false,
      };
    }
  }

  @action
  async refreshExpandedFile(file: IFileTreeItem) {
    const uri = this.getStatutsKey(file);
    if (file.filestat.isDirectory) {
      // 如果当前目录下的子文件为空，同时具备父节点，尝试调用fileservice加载文件
      // 如果当前目录具备父节点(即非根目录)，尝试调用fileservice加载文件
      if (file.children.length === 0 && file.parent || this.status[uri] && this.status[uri].needUpdated && file.parent) {
        for (let i = 0, len = file.parent!.children.length; i < len; i++) {
          if (file.parent!.children[i].id === file.id) {
            const files: IFileTreeItem[] = await this.fileAPI.getFiles(file.filestat, file.parent);
            // 子元素继承旧状态
            this.updateFileStatus(files, Object.assign({}, this.status));
            file.parent!.children[i].children = files[0].children;
            break;
          }
        }
      }
    }
  }

  @action
  async updateFilesExpandedStatus(file: IFileTreeItem) {
    const uri = this.getStatutsKey(file);
    if (file.filestat.isDirectory) {
      if (!file.expanded) {
        // 如果当前目录下的子文件为空，同时具备父节点，尝试调用fileservice加载文件
        // 如果当前目录具备父节点(即非根目录)，尝试调用fileservice加载文件
        if (file.children.length === 0 && file.parent || this.status[uri] && this.status[uri].needUpdated && file.parent) {
          for (let i = 0, len = file.parent!.children.length; i < len; i++) {
            if (file.parent!.children[i].id === file.id) {
              const files: IFileTreeItem[] = await this.fileAPI.getFiles(file.filestat, file.parent);
              this.updateFileStatus(files);
              file.parent!.children[i].children = files[0].children;
              break;
            }
          }
        }
        this.status[uri] = {
          ...this.status[uri],
          expanded: true,
          focused: true,
          selected: true,
          needUpdated: false,
        };
      } else {
        this.status[uri] = {
          ...this.status[uri],
          expanded: false,
          focused: true,
          selected: true,
        };
      }
    }
  }

  @action
  async updateFilesExpandedStatusByQueue(paths: string[]) {
    if (paths.length === 0) {
      return;
    }
    let path = paths.pop();

    while (path && this.status[path]) {
      if (!this.status[path].expanded) {
        await this.updateFilesExpandedStatus(this.status[path].file);
      }
      path = paths.pop();
    }
  }

  @action
  updateFileStatus(files: IFileTreeItem[], status?: IFileTreeItemStatus) {
    files.forEach((file: IFileTreeItem) => {
      const uri = this.getStatutsKey(file);
      if (file.children && file.children.length > 0) {
        if (status) {
          this.status[uri] = {
            ...status[uri],
            file,
          };
        } else {
          this.status[uri] = {
            selected: false,
            focused: false,
            expanded: true,
            file,
          };
        }
        this.updateFileStatus(file.children, status);
      } else {
        if (status) {
          this.status[uri] = {
            ...status[uri],
            file,
          };
        } else {
          this.status[uri] = {
            selected: false,
            focused: false,
            expanded: false,
            file,
          };
        }
      }
    });
  }

  @action
  private async getFiles(roots: IWorkspaceRoots): Promise<IFileTreeItem[]> {
    let result = [];
    for (const root of roots) {
      let files;
      if (root.isDirectory) {
        files = await this.fileAPI.getFiles(root.uri);
        this.updateFileStatus(files);
        result = result.concat(files);
      }
      this.fileServiceWatchers[root.uri] = await this.fileServiceClient.watchFileChanges(new URI(root.uri));
    }
    this.files = result;
    return result;
  }

  /**
   * 打开文件
   * @param uri
   */
  openFile(uri: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, { disableNavigate: true });
  }

  /**
   * 打开并固定文件
   * @param uri
   */
  openAndFixedFile(uri: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.OPEN_RESOURCE.id, uri, { disableNavigate: false });
  }

  /**
   * 比较选中的两个文件
   * @param original
   * @param modified
   */
  compare(original: URI, modified: URI) {
    this.commandService.executeCommand(EDITOR_COMMANDS.COMPARE.id, {
      original,
      modified,
    });
  }
}
