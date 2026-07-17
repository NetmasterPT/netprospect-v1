# Órfãos reincidentes (poison) — lista de retry-policy

Jobs que **voltam a ficar órfãos** (esgotam o `maxDeliver`) ronda após ronda, **com o mesmo erro**.
O monitor de saúde (loop de 15 min) relança automaticamente os órfãos transitórios (que passam à 2ª/3ª
tentativa), mas os que ficam em **loop com o mesmo erro** entram aqui — para decidirmos se vale a pena
continuar a retentar e, se sim, com que política (max-tentativas / janela de tempo / cadência).

Ver a instrução em [`../DEBUGGING-TODO.md`](../DEBUGGING-TODO.md) → "Gestão ativa de órfãos + retries".

## Como o monitor preenche isto
- Regista `domínio · job · assinatura-de-erro · nº-de-vezes-re-orfanado · 1º-visto · último-visto`.
- **≥3 re-orfanamentos com o MESMO erro** → estado **POISON**, o monitor **deixa de relançar** e sinaliza
  na conversa para o utilizador decidir a política.
- Quando decidirmos, anota-se a **política** na coluna (ex.: `desistir` · `max=5` · `retry 1×/dia` ·
  `retry até <data>`). Marca **RESOLVIDO** quando o job passar a ter sucesso ou for descontinuado.

## Reincidentes

| Estado | Job | Domínio(s) | Erro (assinatura) | Vezes | 1º visto | Último visto | Política decidida |
|---|---|---|---|---|---|---|---|
| _(nenhum ainda)_ | | | | | | | |

<!--
Exemplo:
| POISON | lighthouse_mobile | eviindustries.se, axelpriset.se | performance mark has not been set | 4 | 2026-07-17T09:40 | 2026-07-17T10:25 | (a decidir) |
| RESOLVIDO | industry | — | Directus under-pressure | — | — | — | transitório, resolveu sozinho |
-->
