<script lang="ts">
  import type { TagStats } from './tags'
  import { normalizeText } from './tags'

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
      errorMessage = e instanceof Error ? e.message : 'Could not rename tag'
    } finally {
      busy = false
    }
  }

  async function handleMergeSubmit(sourceLabel: string) {
    const target = mergeTarget.trim()
    if (!target) {
      errorMessage = 'Please choose or enter a target tag.'
      return
    }
    if (normalizeText(target) === normalizeText(sourceLabel)) {
      errorMessage = 'Source and target tag must be different.'
      return
    }
    if (!confirm(`Merge all occurrences of “${sourceLabel}” into “${target}”? Duplicate tags on the same image will be combined cleanly.`)) {
      return
    }
    busy = true
    errorMessage = ''
    try {
      await onmergetag(sourceLabel, target)
      mergingSource = null
      mergeTarget = ''
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : 'Could not merge tags'
    } finally {
      busy = false
    }
  }

  async function handleDelete(label: string) {
    if (!confirm(`Delete tag “${label}” everywhere in your library?`)) return
    busy = true
    errorMessage = ''
    try {
      await ondeletetag(label)
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : 'Could not delete tag'
    } finally {
      busy = false
    }
  }
</script>

{#if open}
  <div class="tag-manager-layer">
    <button class="tag-manager-scrim" type="button" aria-label="Close tag manager" onclick={onclose}></button>
    <dialog open class="tag-manager-dialog" aria-modal="true" aria-labelledby="tag-manager-title">
      <div class="tag-manager-heading">
        <h2 id="tag-manager-title">TAG MANAGER</h2>
        <button type="button" class="close-btn" aria-label="Close tag manager" onclick={onclose}>×</button>
      </div>

      <p class="tag-manager-desc">
        Manage all tags in your library. Rename tags globally, or merge synonyms to combine duplicate tags.
      </p>

      <div class="tag-manager-toolbar">
        <input
          type="search"
          placeholder="Filter tags…"
          bind:value={filterQuery}
          aria-label="Filter tags in manager"
          class="tag-filter-input"
        />
        <span class="tag-total-badge">{tags.length} tag{tags.length === 1 ? '' : 's'}</span>
      </div>

      {#if errorMessage}
        <p class="status error" role="alert">{errorMessage}</p>
      {/if}

      <div class="tag-manager-list" role="list">
        {#if filteredTags.length === 0}
          <p class="no-tags">No tags found.</p>
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
                    aria-label="New name for {tag.label}"
                  />
                  <button type="submit" disabled={busy || !renameValue.trim()}>Save</button>
                  <button type="button" disabled={busy} onclick={() => (renamingTag = null)}>Cancel</button>
                </form>
              {:else if mergingSource === tag.label}
                <div class="tag-merge-form">
                  <div class="merge-prompt">
                    Merge <strong>{tag.label}</strong> into:
                  </div>
                  <div class="merge-controls">
                    <select bind:value={mergeTarget} disabled={busy}>
                      <option value="">-- Choose an existing tag --</option>
                      {#each tags.filter((t) => t.normalized !== tag.normalized) as candidate (candidate.normalized)}
                        <option value={candidate.label}>{candidate.label} ({candidate.count})</option>
                      {/each}
                    </select>
                    <input
                      type="text"
                      placeholder="Or enter target tag…"
                      bind:value={mergeTarget}
                      disabled={busy}
                    />
                    <button
                      type="button"
                      class="confirm-merge-btn"
                      disabled={busy || !mergeTarget.trim() || normalizeText(mergeTarget) === tag.normalized}
                      onclick={() => handleMergeSubmit(tag.label)}
                    >
                      Confirm merge
                    </button>
                    <button type="button" disabled={busy} onclick={() => (mergingSource = null)}>Cancel</button>
                  </div>
                </div>
              {:else}
                <div class="tag-info">
                  <strong class="tag-name">{tag.label}</strong>
                  <span class="tag-counts" title="{tag.count} uses across {tag.imageCount} images">
                    {tag.count} {tag.count === 1 ? 'use' : 'uses'} · {tag.imageCount} {tag.imageCount === 1 ? 'image' : 'images'}
                  </span>
                </div>
                <div class="tag-actions">
                  <button type="button" class="btn-action" disabled={busy} onclick={() => startRename(tag)}>Rename</button>
                  <button type="button" class="btn-action" disabled={busy} onclick={() => startMerge(tag)}>Merge into…</button>
                  <button type="button" class="btn-action danger" disabled={busy} onclick={() => handleDelete(tag.label)}>Delete</button>
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
    background: rgba(0, 0, 0, 0.55);
  }
  .tag-manager-dialog {
    position: relative;
    z-index: 1;
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
    color: #fff;
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
    color: #fff !important;
  }
</style>
