# Relatórios Sicredi — automático

Baixa sozinho, todo dia, os relatórios do portal Sicredi maquininhas de todas
as lojas, e guarda na pasta [`relatorios/`](relatorios). São dois por loja,
sempre dos **últimos 7 dias**:

- **Vendas** — relatório simplificado
- **Antecipação** — relatório detalhado por arranjo

## Duas formas de rodar

- **Sozinho, 7h da manhã (seg a sex).** O GitHub roda e guarda os arquivos
  aqui. Quando você chega, já estão prontos.
- **Na hora, quando você quiser.** Duas opções:
  - No GitHub: aba **Actions** → **Baixar relatorios Sicredi** → **Run workflow**.
  - No seu PC: clique duas vezes em **BAIXAR-WINDOWS.bat** (ou **BAIXAR-MAC.command**).

No seu PC o navegador abre na sua frente. Se o portal pedir o **"prove que você
é humano"**, o robô **para e espera você resolver**, depois segue sozinho. No
GitHub isso não tem como — a loja que cair nesse pedido fica na lista
*"faltaram estas"*, e você completa só essas pelo seu PC.

## Onde ficam as senhas (importante)

As senhas **não** ficam neste repositório (ele é público). Ficam em dois
lugares escondidos:

- **Para as 7h automáticas:** em *Settings → Secrets and variables → Actions*,
  do GitHub. Um segredo só, chamado `SICREDI_CONTAS`, com todas as lojas.
- **Para o seu PC:** num arquivo `contas.json` na sua máquina, que **nunca**
  sobe pro GitHub (está no `.gitignore`). Use o `contas-EXEMPLO.json` de molde.

Formato das lojas (o mesmo nos dois lugares):

```json
[
  { "nome": "Loja A", "login": "...", "senha": "...", "email": "..." },
  { "nome": "Loja B", "login": "...", "senha": "...", "email": "..." }
]
```

## O código do acesso, por e-mail

Depois do login, o portal manda um código para o e-mail da loja. O robô lê esse
código sozinho. Para isso, uma vez, você autoriza a leitura do e-mail:

1. No PC, crie um arquivo `.env` com o Client ID e o Client Secret do Google:
   ```
   GMAIL_CLIENT_ID=...
   GMAIL_CLIENT_SECRET=...
   ```
2. Rode uma vez: `npm run autorizar-email` e aprove no navegador.
3. Isso gera a chave de leitura. Para as 7h automáticas, cadastre no GitHub os
   segredos `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` e `GMAIL_REFRESH_TOKEN`
   (o programa mostra o valor do último no fim).

## O que este robô não faz

Não resolve o "prove que você é humano" — quem resolve é você, quando aparecer.
E não mexe em dinheiro: só **lê e baixa** relatórios.
