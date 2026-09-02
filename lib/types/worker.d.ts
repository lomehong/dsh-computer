export declare class ComputerWorker {
    private child;
    private pending;
    private nextId;
    private idleTimer;
    private chain;
    private readonly log;
    constructor(log?: (line: string) => void);
    /** 串行执行：GUI 操作有状态（聚焦/相对位置），逐条排队。 */
    run<T>(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    dispose(): void;
    /** 截图输出目录（懒建）。 */
    screenshotDir(): string;
    private runOnce;
    private ensure;
    private touchIdle;
    private rejectAll;
}
