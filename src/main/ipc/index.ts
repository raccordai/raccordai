import { app, ipcMain } from 'electron'
import { ipcContracts, type IpcChannel, type IpcInput, type IpcOutput } from '@shared/ipc/contracts'
import { dialog } from 'electron'
import { getDbPath } from '../db/client'
import { getReleaseChannel } from '../env'
import { broadcastWorkflowChanged } from '../events'
import { toGeneration, withAssetUrl } from '../media/urls'
import { getLocalApiStatus } from '../server'
import * as graphHistory from '../services/graphHistory'
import * as aiService from '../services/ai'
import * as backupService from '../services/backup'
import * as updaterService from '../services/updater'
import * as chatService from '../services/chat'
import * as assetsService from '../services/assets'
import * as generationsService from '../services/generations'
import * as graph from '../services/graph'
import * as library from '../services/library'
import * as projects from '../services/projects'
import { kieGetCredits } from '../services/kie'
import * as runEngine from '../services/runEngine'
import * as settingsService from '../services/settings'
import * as videosService from '../services/videos'

/**
 * Every handler is wrapped so that inputs AND outputs are validated against
 * the shared zod contracts — a drifting payload fails loudly instead of
 * corrupting state silently.
 */
function handle<C extends IpcChannel>(
  channel: C,
  handler: (input: IpcInput<C>) => IpcOutput<C> | Promise<IpcOutput<C>>
): void {
  ipcMain.handle(channel, async (_event, rawInput: unknown) => {
    const input = ipcContracts[channel].input.parse(rawInput) as IpcInput<C>
    const result = await handler(input)
    return ipcContracts[channel].output.parse(result)
  })
}

export function registerIpcHandlers(): void {
  handle('app:getInfo', () => ({
    version: app.getVersion(),
    channel: getReleaseChannel(),
    platform: process.platform,
    dbPath: getDbPath(),
    localApi: getLocalApiStatus()
  }))

  handle('settings:getLocale', () => settingsService.getLocale())
  handle('settings:setLocale', (locale) => settingsService.setLocale(locale))

  handle('projects:list', () => projects.listProjects())
  handle('projects:get', ({ id }) => projects.getProject(id))
  handle('projects:create', ({ name }) => projects.createProject(name))
  handle('projects:delete', ({ id }) => projects.deleteProject(id))
  handle('projects:rename', ({ id, name }) => projects.renameProject(id, name))
  handle('projects:overview', () => library.projectsOverview())
  handle('videos:overview', ({ projectId }) => library.videosOverview(projectId))

  handle('videos:listByProject', ({ projectId }) => videosService.listVideos(projectId))
  handle('videos:get', ({ videoId }) => videosService.getVideo(videoId))
  handle('videos:create', ({ projectId, name }) => videosService.createVideo(projectId, name))
  handle('videos:rename', ({ videoId, name }) => videosService.renameVideo(videoId, name))
  handle('videos:remove', ({ videoId }) => videosService.deleteVideo(videoId))
  handle('videos:setStyle', ({ videoId, styleId }) => videosService.setVideoStyle(videoId, styleId))

  handle('assets:listByProject', ({ projectId }) =>
    assetsService.listAssets(projectId).map(withAssetUrl)
  )
  handle('assets:get', ({ assetId }) => {
    const asset = assetsService.getAsset(assetId)
    return asset ? withAssetUrl(asset) : null
  })
  handle('assets:importFromDialog', async ({ projectId }) => {
    const result = await dialog.showOpenDialog({
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Media',
          extensions: [
            'jpg',
            'jpeg',
            'png',
            'webp',
            'gif',
            'mp4',
            'mov',
            'webm',
            'mp3',
            'wav',
            'm4a',
            'flac'
          ]
        }
      ]
    })
    if (result.canceled) return []
    return result.filePaths.map((p) =>
      withAssetUrl(assetsService.importAssetFromFile(projectId, p))
    )
  })
  handle('assets:update', ({ assetId, ...patch }) => assetsService.updateAsset(assetId, patch))
  handle('assets:remove', ({ assetId }) => assetsService.deleteAsset(assetId))
  handle('assets:references', ({ assetId }) => assetsService.assetReferences(assetId))
  handle('assets:setTags', ({ assetId, tags }) => assetsService.setAssetTags(assetId, tags))
  handle('assets:duplicateGroups', ({ projectId }) => assetsService.duplicateAssetGroups(projectId))

  handle('graph:get', ({ videoId }) => graph.listGraph(videoId))
  handle('graph:timelineFallbackImages', ({ videoId }) =>
    generationsService.timelineFallbackImages(videoId, graph.listGraph(videoId))
  )
  handle('nodes:create', (input) => graph.createNode(input))
  handle('nodes:updateParams', ({ nodeId, params }) => graph.updateNodeParams(nodeId, params))
  handle('nodes:updateLabel', ({ nodeId, label }) => graph.updateNodeLabel(nodeId, label))
  handle('nodes:updateIntent', ({ nodeId, intent }) => graph.updateNodeIntent(nodeId, intent))
  handle('nodes:updatePosition', ({ nodeId, position }) =>
    graph.updateNodePosition(nodeId, position)
  )
  handle('nodes:updatePositions', ({ updates }) => graph.updateNodePositions(updates))
  handle('nodes:replaceModel', ({ nodeId, modelId }) => graph.replaceNodeModel(nodeId, modelId))
  handle('nodes:remove', ({ nodeId }) => graph.removeNode(nodeId))
  handle('edges:connect', (input) => graph.connectNodes(input))
  handle('edges:disconnect', ({ edgeId }) => graph.disconnectEdge(edgeId))

  handle('history:state', ({ videoId }) => graphHistory.historyState(videoId))
  handle('history:undo', ({ videoId }) => {
    const state = graphHistory.undoGraph(videoId)
    broadcastWorkflowChanged(videoId)
    return state
  })
  handle('history:redo', ({ videoId }) => {
    const state = graphHistory.redoGraph(videoId)
    broadcastWorkflowChanged(videoId)
    return state
  })

  handle('workflow:export', ({ videoId }) => graph.exportWorkflow(videoId))
  handle('workflow:import', ({ videoId, json, replace }) =>
    graph.importWorkflow(videoId, json, replace)
  )

  handle('generations:listForNode', ({ nodeId }) =>
    generationsService.listGenerationsForNode(nodeId).map(toGeneration)
  )
  handle('generations:listForVideo', ({ videoId }) =>
    generationsService.listGenerationsForVideo(videoId).map(toGeneration)
  )
  handle('generations:get', ({ generationId }) => {
    const gen = generationsService.getGeneration(generationId)
    return gen ? toGeneration(gen) : null
  })
  handle('generations:historyForVideo', ({ videoId }) =>
    generationsService.historyForVideo(videoId).map((row) => ({
      ...toGeneration(row),
      nodeLabel: row.nodeLabel,
      modelId: row.modelId,
      isSelected: row.isSelected,
      nodeExists: row.nodeExists
    }))
  )
  handle('generations:select', ({ nodeId, generationId }) =>
    graph.setSelectedGeneration(nodeId, generationId)
  )

  handle('generations:run', ({ nodeId, reuseSatisfied }) =>
    runEngine.runNode(nodeId, reuseSatisfied ?? false)
  )
  handle('generations:refreshStatus', ({ nodeId }) => runEngine.refreshStatus(nodeId))
  handle('generations:cancel', ({ nodeId }) => runEngine.cancelGeneration(nodeId))
  handle('generations:setLastFrame', ({ generationId, jpegBase64 }) =>
    runEngine.setLastFrame(generationId, jpegBase64)
  )
  handle('generations:estimateCost', ({ nodeId }) => ({
    credits: generationsService.estimateNodeRunCredits(nodeId)
  }))
  handle('projects:creditsUsage', ({ projectId }) =>
    generationsService.projectCreditsUsage(projectId)
  )
  handle('kie:credits', async () => ({ credits: await kieGetCredits() }))
  handle('ai:refineImagePrompt', (input) => aiService.refineImagePrompt(input))
  handle('assets:promoteGeneration', async ({ generationId, name, description }) =>
    withAssetUrl(await assetsService.promoteGeneration(generationId, name, description))
  )
  handle('settings:localApiInfo', () => {
    const status = getLocalApiStatus()
    return {
      running: status.running,
      url: status.running ? `http://127.0.0.1:${status.port}/mcp` : null,
      token: settingsService.getLocalApiToken()
    }
  })
  handle('settings:setKieApiKey', ({ key }) => settingsService.setKieApiKey(key))
  handle('settings:kieApiKeyStatus', () => settingsService.kieApiKeyStatus())
  handle('settings:getGenerationConcurrency', () => settingsService.getMaxConcurrentGenerations())
  handle('settings:setGenerationConcurrency', ({ value }) =>
    settingsService.setMaxConcurrentGenerations(value)
  )
  handle('settings:getAssistantModel', () => settingsService.getAssistantModel())
  handle('settings:setAssistantModel', ({ model }) => settingsService.setAssistantModel(model))

  handle('settings:getUpdateChannel', () => settingsService.getUpdateChannel())
  handle('settings:setUpdateChannel', ({ channel }) => {
    settingsService.setUpdateChannel(channel)
    updaterService.applyUpdateChannel()
  })

  handle('update:getState', () => updaterService.getUpdateState())
  handle('update:check', () => updaterService.checkForUpdates())
  handle('update:install', () => updaterService.installUpdate())

  handle('backup:export', async () => {
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog({
      title: 'Export backup',
      defaultPath: `raccord-${stamp}.raccord`,
      filters: [{ name: 'Raccord backup', extensions: ['raccord'] }]
    })
    if (result.canceled || !result.filePath) return null
    const { files, bytes } = await backupService.exportBackup(result.filePath)
    return { path: result.filePath, files, bytes }
  })
  handle('backup:import', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import backup',
      properties: ['openFile'],
      filters: [{ name: 'Raccord backup', extensions: ['raccord'] }]
    })
    const archivePath = result.filePaths[0]
    if (result.canceled || !archivePath) return null
    const restored = await backupService.importBackup(archivePath)
    // Everything in memory (db handle, queue, chat sessions, poller) is stale:
    // relaunch on fresh data right after the response reaches the renderer.
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 300)
    return restored
  })

  handle('chat:get', ({ videoId }) => chatService.getChatState(videoId))
  handle('chat:send', ({ videoId, projectId, text, images }) =>
    chatService.sendChatMessage(videoId, projectId, text, images)
  )
  handle('chat:clear', ({ videoId }) => chatService.clearChat(videoId))
}
