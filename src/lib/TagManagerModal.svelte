<script lang="ts">
  import type { TagStats } from './tags'
  import { normalizeText } from './tags'
  import { t } from './i18n.svelte'

  type Props = {
    open: boolean
    tags: TagStats[]
    onclose: () => void
    onrenametag: (oldLabel: string, newLabel: string) => Promise<void>
    onmergetag: (sourceLabel: string, targetLabel: string) => Promise<void>
    ondeletetag: (label: string) => Promise<void>
  }

  let {
    open,
    tags,
    onclose,
    onrenametag,
    onmergetag,
    ondeletetag,
  }: Props = $props()

  let filterQuery = $state('')
  let renamingTag = $state<string | null>(null)
  let renameValue = $state('')
  let mergingSource = $state<string | null>(null)
  let mergeTarget = $state('')
  let busy = $state(false)
  let errorMessage = $state('')

  const filteredTags = $derived.by(() => {
    const q = normalizeText(filterQuery)
    if (!q) return tags
    return tags.filter((t) => t.normalized.includes(q))
  })

  function startRename(tag: TagStats) {
    mergingSource = null
    renamingTag = tag.label
    renameValue = tag.label
    errorMessage = ''
  }

  function startMerge(tag: TagStats) {
    renamingTag = null
    mergingSource = tag.label
    mergeTarget = ''
    errorMessage = ''
  }

  async function handleRenameSubmit(oldLabel: string) {
    const clean = renameValue.trim()
    if (!clean || clean === oldLabel) {
      renamingTag = null
      return
    }
    busy = true
    errorMessage = ''
    try {
      await onrenametag(oldLabel, clean)
      renamingTag = null
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : t('tagManager.errRename')
    } finally {
      busy = false
    }
  }

  async function handleMergeSubmit(sourceLabel: string) {
    const target = mergeTarget.trim()
    if (!target) {
      errorMessage = t('tagManager.errTargetRequired')
      return
    }
    if (normalizeText(target) === normalizeText(sourceLabel)) {
      errorMessage = t('tagManager.errSameTarget')
      return
    }
    if (!confirm(t('tagManager.confirmMergeDialog', { source: sourceLabel, target }))) {
      return
    }
    busy = true
    errorMessage = ''
    try {
      await onmergetag(sourceLabel, target)
      mergingSource = null
      mergeTarget = ''
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : t('tagManager.errMerge')
    } finally {
      busy = false
    }
  }

  async function handleDelete(label: string) {
    if (!confirm(t('tagManager.confirmDeleteDialog', { label }))) return
    busy = true
    errorMessage = ''
    try {
      await ondeletetag(label)
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : t('tagManager.errDelete')
    } finally {
      busy = false
    }
  }
</script>

{#if open}
  <div class="tag-manager-layer">
    <button class="tag-manager-scrim" type="button" aria-label={t('tagManager.close')} onclick={onclose}></button>
    <dialog open class="tag-manager-dialog" aria-modal="true" aria-labelledby="tag-manager-title">
      <div class="tag-manager-heading">
        <h2 id="tag-manager-title">{t('tagManager.title')}</h2>
        <button type="button" class="close-btn" aria-label={t('tagManager.close')} onclick={onclose}>×</button>
      </div>

      <p class="tag-manager-desc">
        {t('tagManager.desc')}
      </p>

      <div class="tag-manager-toolbar">
        <input
          type="search"
          placeholder={t('tagManager.filterPlaceholder')}
          bind:value={filterQuery}
          aria-label={t('tagManager.filterAria')}
          class="tag-filter-input"
        />
        <span class="tag-total-badge">{t('tagManager.total', { count: tags.length })}</span>
      </div>

      {#if errorMessage}
        <p class="status error" role="alert">{errorMessage}</p>
      {/if}

      <div class="tag-manager-list" role="list">
        {#if filteredTags.length === 0}
          <p class="no-tags">{t('tagManager.none')}</p>
        {:else}
          {#each filteredTags as tag (tag.normalized)}
            <div class="tag-manager-row" role="listitem">
              {#if renamingTag === tag.label}
                <form class="tag-edit-form" onsubmit={(e) => { e.preventDefault(); handleRenameSubmit(tag.label) }}>
                  <input
                    type="text"
                    bind:value={renameValue}
                    disabled={busy}
                    required
                    aria-label={tag.label}
                  />
                  <button type="submit" disabled={busy || !renameValue.trim()}>{t('tagManager.save')}</button>
                  <button type="button" disabled={busy} onclick={() => (renamingTag = null)}>{t('gallery.cancel')}</button>
                </form>
              {:else if mergingSource === tag.label}
                <div class="tag-merge-form">
                  <div class="merge-prompt">
                    {t('tagManager.mergePrompt', { label: tag.label })}
                  </div>
                  <div class="merge-controls">
                    <select bind:value={mergeTarget} disabled={busy}>
                      <option value="">{t('tagManager.chooseTarget')}</option>
                      {#each tags.filter((item) => item.normalized !== tag.normalized) as candidate (candidate.normalized)}
                        <option value={candidate.label}>{candidate.label} ({candidate.count})</option>
                      {/each}
                    </select>
                    <input
                      type="text"
                      placeholder={t('tagManager.enterTarget')}
                      bind:value={mergeTarget}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      class="confirm-merge-btn"
                      disabled={busy || !mergeTarget.trim() || normalizeText(mergeTarget) === tag.normalized}
                      onclick={() => handleMergeSubmit(tag.label)}
                    >
                      {t('tagManager.confirmMerge')}
                    </button>
                    <button type="button" disabled={busy} onclick={() => (mergingSource = null)}>{t('gallery.cancel')}</button>
                  </div>
                </div>
              {:else}
                <div class="tag-info">
                  <strong class="tag-name">{tag.label}</strong>
                  <span class="tag-counts">
                    {t('tagManager.counts', { uses: tag.count, images: tag.imageCount })}
                  </span>
                </div>
                <div class="tag-actions">
                  <button type="button" class="btn-action" disabled={busy} onclick={() => startRename(tag)}>{t('nav.rename')}</button>
                  <button type="button" class="btn-action" disabled={busy} onclick={() => startMerge(tag)}>{t('viewer.mergeInto')}</button>
                  <button type="button" class="btn-action danger" disabled={busy} onclick={() => handleDelete(tag.label)}>{t('nav.delete')}</button>
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </dialog>
  </div>
{/if}

<style>
  .tag-manager-layer {
    position: fixed;
    z-index: 150;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 16px;
  }
  .tag-manager-scrim {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background: rgba(33, 33, 33, 0.55);
  }
  .tag-manager-dialog {
    position: relative;
    z-index: 1;
    margin: 0;
    width: min(580px, 100%);
    max-height: calc(100dvh - 48px);
    display: flex;
    flex-direction: column;
    padding: 20px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
  }
  .tag-manager-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .tag-manager-heading h2 {
    margin: 0;
    font-size: 1.1rem;
    letter-spacing: 0.05em;
  }
  .close-btn {
    border: 0;
    background: transparent;
    font-size: 1.4rem;
    cursor: pointer;
    color: inherit;
    line-height: 1;
    padding: 0 4px;
  }
  .tag-manager-desc {
    margin: 8px 0 14px;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .tag-manager-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }
  .tag-filter-input {
    flex: 1;
    min-width: 0;
    padding: 7px 10px;
    border: 1px solid var(--border);
    border-radius: 0;
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
  }
  .tag-total-badge {
    font-size: 0.8rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .tag-manager-list {
    flex: 1 1 auto;
    overflow-y: auto;
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }
  .tag-manager-row + .tag-manager-row {
    border-top: 1px solid var(--border);
  }
  .no-tags {
    padding: 20px;
    text-align: center;
    color: var(--muted);
    font-size: 0.9rem;
  }
  .tag-manager-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }
  .tag-manager-row:last-child {
    border-bottom: 0;
  }
  .tag-info {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    flex: 1;
  }
  .tag-name {
    font-size: 0.95rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag-counts {
    font-size: 0.8rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .tag-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .btn-action {
    padding: 3px 8px;
    font-size: 0.75rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    border-radius: 0;
    cursor: pointer;
  }
  .btn-action:hover:not(:disabled) {
    background: var(--accent);
    color: var(--bg);
  }
  .btn-action.danger {
    color: var(--danger, #c62828);
  }
  .btn-action.danger:hover:not(:disabled) {
    background: var(--danger, #c62828);
    color: #fff;
  }
  .tag-edit-form {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .tag-edit-form input {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
  }
  .tag-edit-form button {
    padding: 4px 10px;
    font-size: 0.8rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .tag-merge-form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 4px 0;
  }
  .merge-prompt {
    font-size: 0.85rem;
    color: var(--text);
  }
  .merge-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .merge-controls select,
  .merge-controls input {
    padding: 6px 8px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font: inherit;
    font-size: 0.85rem;
    min-width: 140px;
  }
  .merge-controls input {
    flex: 1;
    min-width: 120px;
  }
  .merge-controls button {
    padding: 5px 10px;
    font-size: 0.8rem;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
  }
  .confirm-merge-btn {
    background: var(--accent) !important;
    color: var(--bg) !important;
  }

  @media (max-width: 640px) {
    .tag-manager-layer {
      padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
    }
    .tag-manager-dialog {
      max-height: calc(100dvh - 16px);
      padding: 14px;
    }
    .tag-manager-toolbar {
      flex-wrap: wrap;
      gap: 6px;
    }
    .tag-filter-input {
      font-size: 1rem;
    }
    .tag-manager-row {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      padding: 10px;
    }
    .tag-info {
      flex-wrap: wrap;
      gap: 4px 10px;
    }
    .tag-name {
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .tag-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      width: 100%;
    }
    .btn-action {
      padding: 8px 6px;
      font-size: 0.78rem;
      text-align: center;
    }
    .tag-edit-form {
      flex-wrap: wrap;
    }
    .tag-edit-form input {
      flex: 1 0 100%;
      font-size: 1rem;
    }
    .tag-edit-form button {
      flex: 1;
    }
    .merge-controls select,
    .merge-controls input {
      flex: 1 0 100%;
      width: 100%;
      min-width: 0;
      font-size: 1rem;
    }
    .merge-controls button {
      flex: 1;
    }
  }
</style>
