/** 用法错误（参数不合法等），CLI 以退出码 2 结束。 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

/** 安装/校验失败，CLI 以退出码 1 结束。 */
export class InstallError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "InstallError";
    this.exitCode = 1;
  }
}
