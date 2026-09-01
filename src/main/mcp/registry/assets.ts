import * as assets from '../../services/assets'
import { assetRow, obj, str, type AgentTool } from './types'

/** The project-wide media library, including published design sheets. */
export const assetTools: AgentTool[] = [
  {
    name: 'list_assets',
    description:
      'List a project’s assets (shared by all its videos): id, portable key, name, kind, description. designId/designSubject are set on published design sheets (reference-only: never wire them to a frame anchor).',
    inputSchema: obj({ projectId: str() }, ['projectId']),
    scope: 'project',
    risk: 'read',
    execute: ({ projectId }) => assets.listAssets(String(projectId)).map(assetRow)
  },
  {
    name: 'search_assets',
    description:
      'Search a project’s assets by name, key, description or tag (accent-insensitive, AND terms).',
    inputSchema: obj({ projectId: str(), query: str('Search terms') }, ['projectId', 'query']),
    scope: 'project',
    risk: 'read',
    execute: ({ projectId, query }) =>
      assets
        .searchAssets(String(projectId), String(query))
        .map((a) => ({ ...assetRow(a), tags: a.tags }))
  },
  {
    name: 'set_asset_tags',
    description: 'Replace an asset’s tags (labels used to filter the library).',
    inputSchema: obj({ assetId: str(), tags: { type: 'array', items: { type: 'string' } } }, [
      'assetId',
      'tags'
    ]),
    scope: 'global',
    risk: 'write',
    execute: ({ assetId, tags }) => {
      assets.setAssetTags(String(assetId), Array.isArray(tags) ? tags.map(String) : [])
      return { ok: true }
    }
  },
  {
    name: 'add_asset_from_url',
    description:
      'Download a media URL (image/video/audio) into the project’s asset library. Give it a descriptive name and an AI-facing description.',
    inputSchema: obj(
      {
        projectId: str(),
        url: str('Public URL of the media to download'),
        name: str('Display name (default: URL filename)'),
        description: str('What the media depicts — shown to AIs')
      },
      ['projectId', 'url']
    ),
    scope: 'project',
    risk: 'write',
    execute: async ({ projectId, url, name, description }) => {
      const a = await assets.importAssetFromUrl(
        String(projectId),
        String(url),
        name ? String(name) : undefined,
        description ? String(description) : undefined
      )
      return { id: a.id, key: a.key, name: a.name, kind: a.kind }
    }
  },
  {
    name: 'add_asset_from_file',
    description:
      'Import a local media file (absolute path on this machine) into the project’s asset library.',
    inputSchema: obj(
      {
        projectId: str(),
        path: str('Absolute path of the media file'),
        name: str('Display name (default: file name)'),
        description: str('What the media depicts — shown to AIs')
      },
      ['projectId', 'path']
    ),
    scope: 'project',
    risk: 'write',
    execute: ({ projectId, path, name, description }) => {
      const a = assets.importAssetFromFile(String(projectId), String(path))
      if (name !== undefined || description !== undefined) {
        assets.updateAsset(a.id, {
          ...(name !== undefined ? { name: String(name) } : {}),
          ...(description !== undefined ? { description: String(description) } : {})
        })
      }
      return { id: a.id, key: a.key, name: name ? String(name) : a.name, kind: a.kind }
    }
  },
  {
    name: 'update_asset',
    description:
      'Update an asset’s name, description and/or design subject. Descriptions are shown to AIs — describe what the media depicts.',
    inputSchema: obj(
      {
        assetId: str(),
        name: str(),
        description: str(),
        designSubject: str('The subject a design sheet was built from (design assets only)')
      },
      ['assetId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ assetId, name, description, designSubject }) => {
      assets.updateAsset(String(assetId), {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(designSubject !== undefined ? { designSubject: String(designSubject) } : {})
      })
      return { ok: true }
    }
  },
  {
    name: 'asset_references',
    description:
      'Which videos use an asset (via studio/asset nodes). Check this BEFORE delete_asset — deleting a referenced asset breaks those workflows.',
    inputSchema: obj({ assetId: str() }, ['assetId']),
    scope: 'global',
    risk: 'read',
    execute: ({ assetId }) => assets.assetReferences(String(assetId))
  },
  {
    name: 'delete_asset',
    description:
      'Delete an asset from the project library (studio/asset nodes referencing it lose their media). Destructive — run asset_references first.',
    inputSchema: obj({ assetId: str() }, ['assetId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ assetId }) => {
      assets.deleteAsset(String(assetId))
      return { ok: true }
    }
  },
  {
    name: 'publish_design',
    description:
      'Publish a design node’s successful generation into the project’s asset library as a reusable design sheet (copies the node’s design category and subject). Reuse published sheets across videos instead of regenerating them.',
    inputSchema: obj(
      {
        generationId: str('A successful generation of a design node'),
        name: str('Library display name (e.g. the character’s name)'),
        description: str('What the sheet depicts — shown to AIs')
      },
      ['generationId', 'name']
    ),
    scope: 'global',
    risk: 'write',
    execute: async ({ generationId, name, description }) => {
      const a = await assets.promoteGeneration(
        String(generationId),
        String(name),
        description ? String(description) : undefined
      )
      return {
        id: a.id,
        key: a.key,
        name: a.name,
        designId: a.designId,
        designSubject: a.designSubject
      }
    }
  }
]
