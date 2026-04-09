# deOlho - Monitor de Câmeras RTSP

Aplicação de monitoramento RTSP com backend Node.js/Express, interface web estática e empacotamento Electron para uso local. O fluxo principal é RTSP -> transcodificação em MJPEG -> consumo pela interface.

## Visão geral

- `main.js`: ponto de entrada do Electron.
- `server.js`: API HTTP, autenticação, persistência SQLite e pipeline de stream.
- `public/`: interface web e páginas auxiliares.
- `ffmpeg`: usado para transcodificar o stream RTSP.
- `SQLite`: armazena usuários, câmeras e configurações locais.

## Requisitos

- Node.js 18 ou superior.
- `ffmpeg` instalado no sistema ou resolvido via `FFMPEG_PATH`.
- Ambiente capaz de compilar dependências nativas, se necessário, para `better-sqlite3`.

## Variáveis de ambiente

Crie um arquivo `.env` local a partir de [.env.example](.env.example).

- `AUTH_SECRET`: obrigatório em ambiente real. Chave usada para assinar o cookie de autenticação.
- `PORT`: porta HTTP do servidor. Padrão `3333`.
- `FFMPEG_PATH`: caminho absoluto para o binário do ffmpeg. Use quando não quiser depender do PATH do sistema.

## Instalação

Este projeto é distribuído somente como código-fonte. Não há instalador final para o usuário.

1. Clone o repositório.
```bash
git clone https://github.com/[seu-usuario]/cameras.git
cd cameras
```

2. Instale as dependências.
```bash
npm install
```

3. Configure as variáveis de ambiente locais, se necessário.

## Execução

### Electron

```bash
npm start
```

Inicia o app desktop e sobe o servidor local em `http://localhost:3333`.

### Servidor web

```bash
npm run server
```

Inicia apenas o backend HTTP.

### Desenvolvimento

```bash
npm run dev
```

Roda o servidor com watch mode.

## Persistência

Na primeira inicialização, o banco SQLite é criado automaticamente no diretório de dados da aplicação. Usuários, credenciais de câmera e parâmetros de integração ficam gravados localmente.

## Fluxo de uso

1. Criar usuário em `/cadastro-usuario.html`.
2. Autenticar em `/login.html`.
3. Gerenciar câmeras em `/nova.html` e `/lista.html`.
4. Ajustar a visualização em `/configuracoes.html`.

## Estrutura

```
cameras/
├── main.js
├── server.js
├── package.json
├── public/
│   ├── *.html
│   ├── *.js
│   └── styles.css
└── README_WEB.md
```

## API

### Autenticação

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

### Câmeras

- `GET /api/cameras`
- `GET /api/stream/:id`
- `POST /api/reconnect/:id`
- `GET /api/health`

### Sistema

- `GET /api/version`

## Troubleshooting

### Sem imagem na câmera

1. Valide IP, usuário, senha e caminho RTSP.
2. Confirme se a câmera responde na porta configurada.
3. Verifique se o RTSP está habilitado no firmware.
4. Teste o stream diretamente com um player externo.

### Falha ao iniciar o Electron

```bash
npm run fix:app
npm start
```

### Falha ao compilar `better-sqlite3`

```bash
npm run fix:dev
```

## Licença

Este projeto é fornecido como está.

## Contato

- [Linktree](https://linktr.ee/sandroci02)

**Versão**: v1.0.0 | **Última atualização**: Abril de 2026
