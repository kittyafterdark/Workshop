// Generated from src/ for Workshop 0.2.0. `bun run build` is canonical.


function isWorkshopFrontendMessage(value) {
    if (!value || typeof value !== 'object')
        return false;
    const candidate = value;
    if (candidate.type === 'workshop:cancel-preview') {
        return candidate.requestId === undefined || typeof candidate.requestId === 'string';
    }
    return candidate.type === 'workshop:assemble'
        && typeof candidate.requestId === 'string'
        && typeof candidate.chatId === 'string'
        && Array.isArray(candidate.blocks)
        && !!candidate.promptVariables
        && typeof candidate.promptVariables === 'object';
}
function isWorkshopBackendMessage(value) {
    if (!value || typeof value !== 'object')
        return false;
    const candidate = value;
    if (candidate.type === 'workshop:assembly-result') {
        return typeof candidate.requestId === 'string'
            && !!candidate.result
            && typeof candidate.result === 'object';
    }
    if (candidate.type === 'workshop:assembly-error') {
        return typeof candidate.requestId === 'string' && typeof candidate.error === 'string';
    }
    return false;
}

function errorMessage(error) {
    if (error instanceof Error && error.message)
        return error.message;
    return typeof error === 'string' ? error : 'Prompt assembly failed.';
}
class WorkshopPreviewCoordinator {
    host;
    activeByUser = new Map();
    constructor(host) {
        this.host = host;
    }
    async handle(message, userId) {
        if (message.type === 'workshop:cancel-preview') {
            const active = this.activeByUser.get(userId);
            if (!active)
                return;
            if (message.requestId && message.requestId !== active.requestId)
                return;
            active.controller.abort();
            this.activeByUser.delete(userId);
            return;
        }
        const previous = this.activeByUser.get(userId);
        previous?.controller.abort();
        const controller = new AbortController();
        const active = { requestId: message.requestId, controller };
        this.activeByUser.set(userId, active);
        try {
            const result = await this.host.assemble({
                chatId: message.chatId,
                blocks: message.blocks,
                promptVariables: message.promptVariables,
                signal: controller.signal,
            }, userId);
            if (this.activeByUser.get(userId) !== active || controller.signal.aborted)
                return;
            this.host.sendToFrontend({
                type: 'workshop:assembly-result',
                requestId: message.requestId,
                result,
            }, userId);
        }
        catch (error) {
            if (controller.signal.aborted || this.activeByUser.get(userId) !== active)
                return;
            this.host.sendToFrontend({
                type: 'workshop:assembly-error',
                requestId: message.requestId,
                error: errorMessage(error),
            }, userId);
        }
        finally {
            if (this.activeByUser.get(userId) === active)
                this.activeByUser.delete(userId);
        }
    }
    dispose() {
        for (const active of this.activeByUser.values())
            active.controller.abort();
        this.activeByUser.clear();
    }
}

const previews = new WorkshopPreviewCoordinator({
    assemble: (input, userId) => spindle.assemble(input, userId),
    sendToFrontend: (payload, userId) => spindle.sendToFrontend(payload, userId),
});
spindle.onFrontendMessage((payload, userId) => {
    if (!isWorkshopFrontendMessage(payload))
        return;
    void previews.handle(payload, userId);
});
spindle.log.info('Workshop backend loaded');

