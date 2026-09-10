import { WorkshopPreviewCoordinator } from './backend-core.js'
import { isWorkshopFrontendMessage } from './shared.js'

declare const spindle: import('lumiverse-spindle-types').SpindleAPI

const previews = new WorkshopPreviewCoordinator({
  assemble: (input, userId) => spindle.assemble(input, userId),
  sendToFrontend: (payload, userId) => spindle.sendToFrontend(payload, userId),
})

spindle.onFrontendMessage((payload, userId) => {
  if (!isWorkshopFrontendMessage(payload)) return
  void previews.handle(payload, userId)
})

spindle.log.info('Workshop backend loaded')
