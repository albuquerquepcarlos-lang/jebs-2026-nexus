# JEBs 2026 Nexus — banco compartilhado

A V22.3 foi preparada para usar Cloudflare D1. O aplicativo continua com cache local como fallback, mas, quando o D1 está configurado, os dados passam a ser compartilhados entre celulares/computadores.

## O que fica preservado

- Transportes importados ficam no banco.
- O histórico operacional (`embarques/check-ins`, etapas e conclusão) fica separado dos dados da planilha.
- Uma nova planilha atualiza os dados do transporte sem apagar o histórico já registrado.
- Os status de comparecimento das convocações também ficam no banco.

## Configuração no Cloudflare

1. O banco D1 usado nesta versão é `jebs-2026-nexus22`.
2. Copie o `Database ID`.
3. O `wrangler.toml` desta versão já está preenchido com o Database ID real do `jebs-2026-nexus22`.
4. No terminal, dentro do projeto:

```bash
npx wrangler d1 migrations apply jebs-2026-nexus22 --remote
npx wrangler deploy
```

5. Teste:

```text
https://SEU-DOMINIO/api/health
```

Deve retornar `{"ok":true,"database":"connected"}`.

## Importante

A API de escrita está aberta nesta primeira versão para facilitar o uso compartilhado. Para uso operacional definitivo, recomenda-se colocar autenticação/Cloudflare Access antes de distribuir o endereço publicamente.
