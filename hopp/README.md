# API tests (Hoppscotch)

Coleções [Hoppscotch](https://hoppscotch.io) versionadas + runner por CLI para smoke/contract-tests
dos endpoints HTTP do NetProspect. Complementa os testes unitários (Vitest, em `test/`).

## Correr

```bash
npm run api:test          # = hopp test hopp/netprospect.json -e hopp/env.local.json
```

Precisa de alcançar os backends (tailnet). O `hopp` (`@hoppscotch/cli`, devDependency) corre cada request
e executa os `testScript` (asserções `pw.expect`). Sai ≠0 se algum falhar → serve para CI.

## Ficheiros

- **`netprospect.json`** — a coleção. Pastas: `kb-http (docs)` (health, chat/providers, modules, search,
  notebook/escalate) e `dashboard` (config). URLs por variável `<<KB_BASE>>` / `<<DASH_BASE>>`.
- **`env.local.json`** — ambiente (URLs tailnet). Para outro alvo, copia e aponta `KB_BASE`/`DASH_BASE`.

Editar visualmente: importar `netprospect.json` na app Hoppscotch (ou self-hosted), alterar, re-exportar.

## Notas

- O request **notebook/escalate** cria mesmo uma *source* de teste no notebook "NetProspect Docs" (não há
  dry-run na API) — inofensivo, mas apaga-se em bloco se acumular.
- Endpoints atrás de Authentik (ex.: subdomínios `netprospect.*`) precisam de auth na coleção; os aqui
  cobertos são tailnet-only (sem auth).
- Na Fase 6 estes contract-tests entram no pipeline (Jenkins) a par do Sonar (LCOV do Vitest).
