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

## Baixar o extrato bancário (Internet Banking)

Além dos relatórios da maquininha, há um robô para o **extrato bancário** do
Sicredi Internet Banking PJ: entra com CNPJ + login + senha, baixa a planilha de
**cada conta** do acesso e guarda em [`extratos/`](extratos). É **só consulta** —
lê e baixa, não mexe em dinheiro — e **roda só no PC**, com o navegador visível
(não dá para rodar no GitHub).

Setup (uma vez), na máquina que vai rodar:

1. Instale o **Node.js** LTS: <https://nodejs.org>
2. Crie o `banco.json` (molde em `banco-EXEMPLO.json`), com o acesso do Sicredi:
   ```json
   { "cnpj": "00.000.000/0001-00", "login": "...", "senha": "..." }
   ```
   Ele **nunca** sobe para o GitHub (está no `.gitignore`); fica só nesse PC.
   Período: padrão "Últimos 7 dias"; troque com `"periodo": "Ultimos 30 dias"`.
3. Rode:
   - clique duas vezes em **BAIXAR-EXTRATO-WINDOWS.bat** (ou **BAIXAR-EXTRATO-MAC.command**);
   - ou no terminal: `node scripts/extrato-banco.js`.

Os arquivos saem em `extratos/`, no mesmo formato que o painel de conciliação lê.
(Há também `extrato-bradesco.js` + `banco-bradesco.json` para o Bradesco.)

### Só o dia útil anterior

Mesmo robô, mesmo `banco.json`, mas baixa **só o dia útil anterior** a hoje
(na segunda, baixa a sexta; depois de feriado, pula o feriado). O arquivo sai
com a data do extrato no nome, ex.: `extrato_..._2026-11-13.xls`.

- clique duas vezes em **BAIXAR-EXTRATO-DIA-ANTERIOR-WINDOWS.bat** (ou **...-MAC.command**);
- ou no terminal: `node scripts/extrato-dia-anterior.js`
  - `--mostrar` só mostra qual data vai baixar, sem entrar no banco;
  - `--data 13/11/2026` baixa um dia específico;
  - `--ofx` e números de conta funcionam igual ao robô normal.

Feriados nacionais (incluindo Carnaval, Sexta-feira Santa e Corpus Christi) já
são pulados. Feriado da sua cidade/estado: adicione no `banco.json`:
`"feriados": ["2026-01-20"]`.

## O que este robô não faz

Não resolve o "prove que você é humano" — quem resolve é você, quando aparecer.
E não mexe em dinheiro: só **lê e baixa** relatórios.
