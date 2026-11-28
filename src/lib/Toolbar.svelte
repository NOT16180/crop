<script lang="ts">
  import { t } from './i18n.svelte'

  type Props = {
    menuOpen: boolean
    theme: 'dark' | 'light'
    ontogglemenu: () => void
    ontoggletheme: () => void
    onresetview: () => void
    query: string
    onquerychange: (q: string) => void
    searchSuggestions: { label: string; count: number }[]
    onaddimages: () => void
  }

  let {
    menuOpen,
    theme,
    ontogglemenu,
    ontoggletheme,
    onresetview,
    query,
    onquerychange,
    searchSuggestions,
    onaddimages,
  }: Props = $props()

  let activeSearchSuggestion = $state(-1)

  function onKeydown(event: KeyboardEvent) {
    if (!searchSuggestions.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      activeSearchSuggestion = event.key === 'ArrowDown'
        ? (activeSearchSuggestion + 1) % searchSuggestions.length
        : (activeSearchSuggestion <= 0 ? searchSuggestions.length - 1 : activeSearchSuggestion - 1)
    } else if (event.key === 'Enter' && activeSearchSuggestion >= 0) {
      event.preventDefault()
      onquerychange(searchSuggestions[activeSearchSuggestion].label)
      activeSearchSuggestion = -1
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      activeSearchSuggestion = -1
    }
  }
</script>

<header>
  <button type="button" class="menu-toggle" aria-expanded={menuOpen} aria-controls="side-menu" onclick={ontogglemenu}>
    <span aria-hidden="true">☰</span> {t('toolbar.menu')}
  </button>
  <a class="brand-link" href="/" onclick={(event) => {
    event.preventDefault()
    onresetview()
  }}><h1>CROP</h1></a>
  <form class="search-form" onsubmit={(e) => e.preventDefault()}>
    <div class="search-control">
      <input
        type="search"
        placeholder={t('toolbar.searchPlaceholder')}
        value={query}
        oninput={(e) => {
          onquerychange(e.currentTarget.value)
          activeSearchSuggestion = -1
        }}
        aria-label={t('toolbar.searchAria')}
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls="search-suggestions"
        aria-expanded={searchSuggestions.length > 0}
        aria-activedescendant={activeSearchSuggestion >= 0 && searchSuggestions.length > 0 ? `search-suggestion-${activeSearchSuggestion}` : undefined}
        onkeydown={onKeydown}
        autocomplete="off"
      />
      {#if query.trim().length > 0}
        <button type="button" class="clear-search" onclick={() => onquerychange('')} aria-label={t('toolbar.clearSearch')} title={t('toolbar.clearSearch')}>×</button>
      {/if}
      {#if searchSuggestions.length > 0}
        <div class="autocomplete-list" id="search-suggestions" role="listbox" aria-label={t('toolbar.tagSuggestions')}>
          {#each searchSuggestions as entry, index (entry.label)}
            <button
              type="button"
              id="search-suggestion-{index}"
              role="option"
              aria-selected={activeSearchSuggestion === index}
              class:active={activeSearchSuggestion === index}
              onclick={() => { onquerychange(entry.label); activeSearchSuggestion = -1 }}
            >
              {entry.label}<span>{entry.count}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </form>
  <div class="header-actions">
    <button
      type="button"
      class="theme-toggle"
      onclick={ontoggletheme}
      aria-label={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
      aria-pressed={theme === 'dark'}
      title={theme === 'dark' ? t('theme.toLight') : t('theme.toDark')}
    >
      {#if theme === 'dark'}
        <svg class="theme-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>
        </svg>
        <span class="theme-toggle-label">{t('theme.light')}</span>
      {:else}
        <svg class="theme-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
        <span class="theme-toggle-label">{t('theme.dark')}</span>
      {/if}
    </button>
    <button type="button" class="add-image-button" onclick={onaddimages} title={t('toolbar.addImagesTitle')}>{t('toolbar.addImages')}</button>
  </div>
</header>
