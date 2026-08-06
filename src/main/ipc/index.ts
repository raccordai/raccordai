import { copyFile } from 'node:fs/promises'
import { extname } from 'node:path'
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
import * as annotationsService from '../services/annotations'
import * as checkpointsService from '../services/checkpoints'
import * as backupService from '../services/backup'
import * as updaterService from '../services/updater'
import * as chatService from '../services/chat'
import * as assetsService from '../services/assets'
import * as castingService from '../services/casting'
import * as scenarioGraph from '../services/scenarioGraph'
import * as generationsService from '../services/generations'
import * as graph from '../services/graph'
import * as library from '../services/library'
import * as projects from '../services/projects'
import { kieGetCredits, kieTestApiKey } from '../services/kie'
import { getLogger, logWarn } from '../services/logger'
import * as nichesService from '../services/niches'
import * as notificationsService from '../services/notifications'
import * as qcService from '../services/qc'
import * as recipesService from '../services/recipes'
import * as runBatchService from '../services/runBatch'
import * as renderService from '../services/render'
import * as runEngine from '../services/runEngine'
import * as settingsService from '../services/settings'
import { elevenlabsListVoices } from '../services/elevenlabs'
import * as voicePersonasService from '../services/voicePersonas'
import * as textLayersService from '../services/textLayers'
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
  handle('videos:setDefaults', ({ videoId, ...defaults }) =>
    videosService.setVideoDefaults(videoId, defaults)
  )
  handle('videos:setDraftMode', ({ videoId, enabled }) =>
    videosService.setDraftMode(videoId, enabled)
  )
  handle('videos:setQcEnabled', ({ videoId, enabled }) =>
    videosService.setQcEnabled(videoId, enabled)
  )

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
  handle('assets:importFromPaths', ({ projectId, paths }) => {
    const imported: ReturnType<typeof withAssetUrl>[] = []
    for (const p of paths) {
      try {
        imported.push(withAssetUrl(assetsService.importAssetFromFile(projectId, p)))
      } catch (err) {
        // Unsupported file type — the renderer reports the skipped count.
        logWarn('assets', `import skipped for ${p}: ${err instanceof Error ? err.message : err}`)
      }
    }
    return imported
  })
  handle('assets:update', ({ assetId, ...patch }) => assetsService.updateAsset(assetId, patch))
  handle('assets:remove', ({ assetId }) => assetsService.deleteAsset(assetId))
  handle('assets:references', ({ assetId }) => assetsService.assetReferences(assetId))
  handle('assets:setTags', ({ assetId, tags }) => assetsService.setAssetTags(assetId, tags))
  handle('assets:duplicateGroups', ({ projectId }) => assetsService.duplicateAssetGroups(projectId))

  handle('casting:listByProject', ({ projectId }) => castingService.listCastings(projectId))
  handle('casting:create', (input) => castingService.createCasting(input))
  handle('casting:update', ({ castingId, ...patch }) =>
    castingService.updateCasting(castingId, patch)
  )
  handle('casting:remove', ({ castingId }) => castingService.deleteCasting(castingId))
  handle('casting:plan', (input) => castingService.planCastRole(input))
  // The wiring is journaled by withGraphHistoryGroup, which broadcasts
  // event:workflowChanged on its own — no manual refresh here.
  handle('casting:apply', (input) => castingService.castRole(input))
  handle('casting:onVideo', ({ videoId, projectId }) =>
    castingService.castingsOnVideo(videoId, projectId)
  )

  handle('scenario:planGraph', (input) => scenarioGraph.planScenarioGraph(input))
  // Same rule as casting: the whole build is one history group, which broadcasts
  // event:workflowChanged itself.
  handle('scenario:buildGraph', (input) => scenarioGraph.buildGraphFromScenario(input))

  handle('graph:get', ({ videoId }) => graph.listGraph(videoId))
  handle('graph:timelineFallbackImages', ({ videoId }) =>
    generationsService.timelineFallbackImages(videoId, graph.listGraph(videoId))
  )
  handle('nodes:create', (input) => graph.createNode(input))
  handle('recipes:createNode', (input) => recipesService.createRecipeNode(input))
  handle('nodes:updateParams', ({ nodeId, params }) => graph.updateNodeParams(nodeId, params))
  handle('nodes:updateLabel', ({ nodeId, label }) => graph.updateNodeLabel(nodeId, label))
  handle('nodes:updateIntent', ({ nodeId, intent }) => graph.updateNodeIntent(nodeId, intent))
  handle('nodes:updatePosition', ({ nodeId, position }) =>
    graph.updateNodePosition(nodeId, position)
  )
  handle('nodes:updatePositions', ({ updates }) => graph.updateNodePositions(updates))
  handle('nodes:setTimelineOrder', ({ videoId, nodeIds }) =>
    graph.setTimelineOrder(videoId, nodeIds)
  )
  handle('nodes:setTrim', ({ nodeId, trimStartSec, trimEndSec }) =>
    graph.setClipTrim(nodeId, { trimStartSec, trimEndSec })
  )
  handle('nodes:setTransition', ({ nodeId, transition, durationSec }) =>
    graph.setClipTransition(nodeId, transition, durationSec)
  )
  handle('nodes:setOverlay', ({ nodeId, overlay }) => graph.setClipOverlay(nodeId, overlay))
  handle('textLayers:list', ({ videoId }) => textLayersService.listTextLayers(videoId))
  handle('textLayers:create', (input) => textLayersService.createTextLayer(input))
  handle('textLayers:update', ({ id, patch }) => textLayersService.updateTextLayer(id, patch))
  handle('textLayers:delete', ({ id }) => textLayersService.deleteTextLayer(id))
  handle('nodes:replaceModel', ({ nodeId, modelId }) => graph.replaceNodeModel(nodeId, modelId))
  handle('nodes:applyVideoDefaults', ({ videoId }) => graph.applyVideoDefaultsToNodes(videoId))
  handle('nodes:remove', ({ nodeId }) => graph.removeNode(nodeId))
  handle('edges:connect', (input) => graph.connectNodes(input))
  handle('edges:disconnect', ({ edgeId }) => graph.disconnectEdge(edgeId))
  handle('edges:reorder', (input) => graph.reorderEdges(input))
  handle('edges:rewire', ({ edgeId, targetHandle }) => graph.rewireEdge(edgeId, targetHandle))

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

  handle('generations:run', ({ nodeId, reuseSatisfied, variants }) =>
    runEngine.runNode(nodeId, reuseSatisfied ?? false, { variants })
  )
  handle('generations:planRun', ({ videoId, targetNodeIds, reuseTargets, variants }) =>
    runBatchService.planBatch(videoId, targetNodeIds, reuseTargets, variants)
  )
  // Resolves once the whole batch settled — the renderer's spinner awaits it.
  handle(
    'generations:runBatch',
    ({ videoId, targetNodeIds, reuseTargets, variants }) =>
      runBatchService.startBatch({ videoId, targetNodeIds, reuseTargets, variants }).done
  )
  handle('generations:planFinalize', ({ videoId }) => runBatchService.planFinalize(videoId))
  handle('generations:reviewGeneration', ({ generationId }) =>
    qcService.reviewGeneration(generationId)
  )

  // §6.3 regional feedback
  handle('annotations:list', ({ generationId }) => annotationsService.listAnnotations(generationId))
  handle('annotations:add', (input) => annotationsService.addAnnotation(input))
  handle('annotations:delete', ({ annotationId }) =>
    annotationsService.deleteAnnotation(annotationId)
  )
  handle('annotations:createEditNode', ({ generationId }) =>
    annotationsService.createEditNodeFromAnnotations(generationId)
  )

  // §6.4 checkpoints
  handle('checkpoints:list', ({ videoId }) => checkpointsService.listCheckpoints(videoId))
  handle('checkpoints:create', ({ videoId, name }) =>
    checkpointsService.createCheckpoint(videoId, name)
  )
  handle('checkpoints:delete', ({ checkpointId }) =>
    checkpointsService.deleteCheckpoint(checkpointId)
  )
  handle('checkpoints:diff', ({ checkpointId }) =>
    checkpointsService.diffAgainstCurrent(checkpointId)
  )
  handle('checkpoints:restore', ({ checkpointId }) =>
    checkpointsService.restoreCheckpoint(checkpointId)
  )
  handle('generations:finalizeVideo', ({ videoId }) => runBatchService.finalizeVideo(videoId).done)
  handle('generations:refreshStatus', ({ nodeId }) => runEngine.refreshStatus(nodeId))
  handle('generations:cancel', ({ nodeId }) => runEngine.cancelGeneration(nodeId))
  handle('generations:setLastFrame', ({ generationId, jpegBase64 }) =>
    runEngine.setLastFrame(generationId, jpegBase64)
  )
  handle('generations:exportImage', async ({ generationId, defaultFileName }) => {
    const row = generationsService.getGeneration(generationId)
    if (!row?.resultPath) {
      throw new Error('This generation has no downloaded media to export.')
    }
    if (!(row.resultMimeType ?? '').startsWith('image/')) {
      throw new Error('Only image generations can be exported as a file.')
    }
    const ext = extname(row.resultPath).replace('.', '') || 'png'
    const base =
      (defaultFileName ?? 'thumbnail').replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'thumbnail'
    const result = await dialog.showSaveDialog({
      title: 'Export image',
      defaultPath: `${base}.${ext}`,
      filters: [{ name: 'Image', extensions: [ext] }]
    })
    if (result.canceled || !result.filePath) return null
    await copyFile(row.resultPath, result.filePath)
    return { path: result.filePath }
  })
  handle('generations:queueState', () => runEngine.queueState())
  handle('notifications:batchSummary', ({ succeeded, failed }) =>
    notificationsService.notifyBatchSummary(succeeded, failed)
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
  handle('settings:testKieApiKey', async () => ({ status: await kieTestApiKey() }))
  handle('settings:setYoutubeApiKey', ({ key }) => settingsService.setYoutubeApiKey(key))
  handle('settings:setDataForSeoLogin', ({ value }) => settingsService.setDataForSeoLogin(value))
  handle('settings:setDataForSeoPassword', ({ value }) =>
    settingsService.setDataForSeoPassword(value)
  )
  handle('settings:nicheKeysStatus', () => settingsService.nicheKeysStatus())
  handle('settings:setElevenLabsApiKey', ({ value }) => settingsService.setElevenLabsApiKey(value))
  handle('settings:elevenLabsKeyStatus', () => settingsService.elevenLabsKeyStatus())

  // Speech (§8) — ElevenLabs voices + the channel's named voice personas.
  handle('speech:listVoices', ({ search }) => elevenlabsListVoices({ search }))
  handle('voicePersonas:list', ({ nicheId }) => voicePersonasService.listVoicePersonas(nicheId))
  handle('voicePersonas:create', (input) => voicePersonasService.createVoicePersona(input))
  handle('voicePersonas:update', ({ personaId, ...patch }) =>
    voicePersonasService.updateVoicePersona(personaId, patch)
  )
  handle('voicePersonas:remove', ({ personaId }) =>
    voicePersonasService.deleteVoicePersona(personaId)
  )

  // YouTube niche research (§7) — services broadcast event:nichesChanged themselves.
  handle('niches:list', () => nichesService.listNiches())
  handle('niches:get', ({ nicheId }) => nichesService.getNiche(nicheId))
  handle('niches:create', (input) => nichesService.createNiche(input))
  handle('niches:update', ({ nicheId, ...patch }) => nichesService.updateNiche(nicheId, patch))
  handle('niches:delete', ({ nicheId }) => nichesService.deleteNiche(nicheId))
  handle('niches:addChannel', (input) => nichesService.addChannel(input))
  handle('niches:updateChannel', ({ nicheChannelId, ...patch }) =>
    nichesService.updateChannel(nicheChannelId, patch)
  )
  handle('niches:removeChannel', ({ nicheChannelId }) =>
    nichesService.removeChannel(nicheChannelId)
  )
  handle('niches:refresh', ({ nicheId, videosPerChannel }) =>
    nichesService.refreshNiche(nicheId, videosPerChannel)
  )
  handle('niches:videos', ({ nicheId, filters, limit }) =>
    nichesService.listNicheVideos(nicheId, filters, limit)
  )
  handle('niches:keywordSearch', (input) => nichesService.keywordSearch(input))
  handle('niches:roadmap', ({ nicheId }) => nichesService.listRoadmap(nicheId))
  handle('niches:addRoadmapItem', (input) => nichesService.addRoadmapItem(input))
  handle('niches:updateRoadmapItem', ({ itemId, ...patch }) =>
    nichesService.updateRoadmapItem(itemId, patch)
  )
  handle('niches:deleteRoadmapItem', ({ itemId }) => nichesService.deleteRoadmapItem(itemId))
  handle('niches:assignRoadmapItem', ({ itemId, ...target }) =>
    nichesService.assignRoadmapItem(itemId, target)
  )
  handle('niches:markRoadmapPublished', ({ itemId, url }) =>
    nichesService.markRoadmapPublished(itemId, url)
  )
  handle('niches:fetchTranscripts', (input) => nichesService.fetchTranscripts(input))
  handle('niches:getTranscript', ({ nicheVideoId }) => nichesService.getTranscript(nicheVideoId))
  handle('settings:getOnboardingCompleted', () => settingsService.getOnboardingCompleted())
  handle('settings:setOnboardingCompleted', () => settingsService.setOnboardingCompleted())
  handle('settings:getNotifyOnCompletion', () => settingsService.getNotifyOnCompletion())
  handle('settings:setNotifyOnCompletion', ({ enabled }) =>
    settingsService.setNotifyOnCompletion(enabled)
  )
  handle('settings:getGenerationConcurrency', () => settingsService.getMaxConcurrentGenerations())
  handle('settings:setGenerationConcurrency', ({ value }) =>
    settingsService.setMaxConcurrentGenerations(value)
  )
  handle('settings:getAssistantModel', () => settingsService.getAssistantModel())
  handle('settings:setAssistantModel', ({ model }) => settingsService.setAssistantModel(model))
  handle('settings:getAssistantRunApproval', () => settingsService.getAssistantRunApproval())
  handle('settings:setAssistantRunApproval', ({ mode }) =>
    settingsService.setAssistantRunApproval(mode)
  )

  handle('settings:getUpdateChannel', () => settingsService.getUpdateChannel())
  handle('settings:setUpdateChannel', ({ channel }) => {
    settingsService.setUpdateChannel(channel)
    updaterService.applyUpdateChannel()
  })

  handle('log:renderer', ({ level, scope, message }) =>
    getLogger()[level](`renderer:${scope}`, message)
  )
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

  handle('render:export', async ({ videoId, fps, resolution, burnSubtitles, watermark }) => {
    const video = videosService.getVideo(videoId)
    const base = (video?.name ?? 'video').replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'video'
    const result = await dialog.showSaveDialog({
      title: 'Export MP4',
      defaultPath: `${base}.mp4`,
      filters: [{ name: 'MPEG-4 video', extensions: ['mp4'] }]
    })
    if (result.canceled || !result.filePath) return null
    const { durationSeconds, skipped } = await renderService.renderVideo({
      videoId,
      outputPath: result.filePath,
      fps,
      resolution,
      burnSubtitles,
      watermark
    })
    return { path: result.filePath, durationSeconds, skipped }
  })
  handle('render:cancel', ({ videoId }) => renderService.cancelRender(videoId))

  handle('chat:get', ({ threadId }) => chatService.getChatState(threadId))
  handle('chat:send', ({ threadId, projectId, text, images, context }) =>
    chatService.sendChatMessage(threadId, projectId ?? '', text, images, context)
  )
  handle('chat:clear', ({ threadId }) => chatService.clearChat(threadId))
  handle('chat:stop', ({ threadId }) => chatService.stopChat(threadId))
  handle('chat:listThreads', () => chatService.listThreads())
  handle('chat:newThread', ({ projectId }) => ({
    threadId: chatService.newThread(projectId ? { projectId } : {})
  }))
  handle('chat:renameThread', ({ threadId, title }) => chatService.renameThread(threadId, title))
  handle('chat:deleteThread', ({ threadId }) => chatService.deleteThread(threadId))
  handle('chat:listTools', () => chatService.listAssistantTools())
}
