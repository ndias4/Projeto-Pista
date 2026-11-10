# PISTA

PISTA é um app web de condução musical para festas em casa. O objetivo é simples: o anfitrião conecta o Spotify, escolhe playlists e a fase da noite, e o sistema organiza a sequência musical com foco em clima, energia e pouca intervenção manual.

O projeto foi pensado como uma versão de teste de um “condutor musical” e não como um DJ que mistura áudio em tempo real.

## Visão geral

- O anfitrião escolhe uma ou mais playlists;
- define as fases da noite (aquecimento, pico, fim de noite);
- marca a energia das músicas manualmente ou usa palpite por título;
- o app planeja a sequência com base em curva de energia e evita repetições desnecessárias;
- a próxima faixa é colocada na fila do Spotify;
- o usuário pode intervir com ações como pausar, pular, aumentar/diminuir energia, tocar agora, encerrar ou exportar o log.

## Como rodar

### Node/Express (recomendado)

```bash
cd C:\Users\F_Dia\Documents\PISTA\PISTA
npm install
npm start
```

O app sobe em `http://127.0.0.1:8888` e serve o painel e a rota de convidados.

### Windows legado

O servidor PowerShell continua disponível como alternativa, mas foi marcado como obsoleto:

```powershell
cd C:\Users\F_Dia\Documents\PISTA\PISTA
npm run start:legacy
```

Ou use o atalho `INICIAR-PISTA.bat` para o fluxo antigo localmente.

### Render

1. Crie um Web Service no Render.
2. Conecte o repositório.
3. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Defina a variável de ambiente `PUBLIC_URL` como `https://<app>.onrender.com`.
5. Cadastre a Redirect URI do Spotify em `https://<app>.onrender.com/callback`.
6. Mantenha `http://127.0.0.1:8888/callback` para uso local.

## Estrutura do projeto

```text
PISTA/
├── INICIAR-PISTA.bat
├── LEIA-ME.txt
├── LIBERAR-FIREWALL.bat
├── README.md
├── package.json
├── servidor.ps1
├── site/
│   ├── index.html
│   ├── guest.html
│   ├── css/
│   └── js/
│       ├── app.js
│       ├── audio.js
│       ├── claude.js
│       ├── conductor.js
│       ├── demo.js
│       ├── planner.js
│       ├── playback.js
│       ├── spotify.js
│       └── store.js
├── tests/
│   ├── e2e.mjs
│   └── planner.test.mjs
└── .gitignore
```

## Componentes principais

### `site/js/planner.js`

Motor determinístico da sequência musical. Calcula:

- curva de energia por fase;
- pontuação das faixas candidatas;
- busca em feixe para escolher a próxima música;
- regras de artista repetido, fase e “nunca tocar”.

### `site/js/conductor.js`

Controla a festa:

- máquina de estados da sessão;
- início, pausa, retomada, fim e recuperação;
- fila comprometida;
- log de eventos e exportação de métricas.

### `site/js/playback.js`

Motor de reprodução:

- Spotify via Web Playback SDK ou aparelho conectado;
- modo demo sem Spotify;
- modo local/áudio com Web Audio.

### `site/js/spotify.js`

Autenticação e integração com a Web API do Spotify, incluindo fluxo PKCE.

### `site/js/claude.js`

Integração opcional com IA para:

- interpretar a intenção do anfitrião;
- sugerir fases da noite;
- estimar energia e gênero em modo experimental.

A configuração agora aceita provedor selecionado em menu dropdown (Claude, Gemini, OpenAI/ChatGPT ou Haikai), com campo de chave e modelo abaixo. A integração real continua priorizando o provedor ativo e mantém compatibilidade com o fluxo Claude atual.

## Requisitos

- Windows 10/11;
- Chrome ou Edge;
- conta Spotify Premium para uso com reprodução real;
- Node.js para validar testes automatizados.

## Solução rápida para Windows

Se o terminal não reconhecer `node` ou `npm`, normalmente é porque o Node.js ainda não foi adicionado ao `PATH` do sistema.

1. Instale o Node.js LTS em https://nodejs.org/
2. Reinicie o terminal;
3. Confirme:

```powershell
node -v
npm -v
```

Se precisar rodar manualmente no PowerShell com o Node instalado em `C:\Program Files\nodejs`:

```powershell
$env:PATH = "C:\Program Files\nodejs;$env:PATH"
cd C:\Users\F_Dia\Documents\PISTA\PISTA
npm test
```

## Testes

```powershell
cd C:\Users\F_Dia\Documents\PISTA\PISTA
node tests\planner.test.mjs
node tests\e2e.mjs
```

## IA local (opcional)

No modo de importação de arquivos locais (`app.sourceKind === 'local'`), o PISTA pode estimar a energia de cada faixa diretamente no navegador com um modelo de áudio local do Hugging Face.

- Modelo usado: `Xenova/clap-htsat-unfused` via `@huggingface/transformers` em um worker em módulo.
- O processamento acontece no próprio navegador: o modelo é baixado na primeira vez e fica em cache local do navegador.
- O app não envia áudio para servidor nem precisa de chave de API.
- Só funciona com bibliotecas locais importadas do disco; o modo Spotify continua sem acesso ao áudio.
- A nota do anfitrião sempre prevalece. A IA local só pode preencher faixas sem override do host.

Essa opção é totalmente opcional e não bloqueia o fluxo principal do app.

## Observações importantes

- O projeto não mixa áudio do Spotify nem altera o andamento da música.
- A experiência prioriza condução da noite em vez de beatmatching.
- O app funciona de forma local, sem backend de produção para o fluxo principal.
- A IA é opcional e não é necessária para o funcionamento principal.

## Estado do projeto

O projeto já está validado em:

- testes unitários do planejador;
- testes E2E do fluxo principal;
- autenticação e controle do Spotify;
- simulação de demonstração e retomada após recarga.

## Próximos passos sugeridos

1. Melhorar o onboarding eUX do setup inicial;
2. Adicionar documentação de arquitetura em mais detalhe;
3. Melhorar o painel de controle durante a festa;
4. Validar cenário de múltiplas playlists por fase com experiências reais;
5. Refinar métricas finais e exportação de logs.

## Licença

Este projeto é um protótipo e foi desenvolvido para uso privado e doméstico, conforme a proposta inicial da documentação do produto.
