# R. Daneel — WhatsApp

R. Daneel é o bot pessoal de WhatsApp do Felipe, em homenagem ao robô de Isaac Asimov. O projeto começa com figurinhas e poderá receber outras funcionalidades conforme surgirem necessidades.

A primeira função: envie uma **imagem com a legenda `!figurinha`** e receba uma figurinha estática. Implementado em TypeScript + Baileys + Sharp, com conversão local.

Pasta e nome do pacote: `r-daneel-whatsapp`. Caminho local: `/Users/felipepalombo/Projetos/r-daneel-whatsapp`.

## Estado atual

Figurinhas já validadas pelo usuário no WhatsApp. Download de vídeo público validado localmente; envio de vídeo no WhatsApp ainda precisa de teste com o bot em execução. Nenhum serviço foi publicado.

Baileys é uma integração **não oficial**, sujeita a mudanças do WhatsApp e bloqueio de conta. Use o número separado planejado. Versão fixada `7.0.0-rc14` (release candidate disponível no npm na pesquisa): atualização deve ser deliberada, seguida de testes.

## Começar sem eSIM

Requer Node.js 22.12+ e npm.

```sh
npm ci
npm run check
npm run convert -- /caminho/foto.jpg /caminho/figurinha.webp
```

O destino da conversão não pode existir (proteção contra sobrescrita). Aceita JPEG, PNG ou WebP estático até 10 MB e 25 milhões de pixels. Corrige orientação, preserva proporção/fundo, adiciona bordas transparentes e remove metadados. Não remove o fundo original, não gera imagens com IA e não processa vídeo/GIF.

## Vincular quando tiver o número

1. Registre o número separado no WhatsApp/WhatsApp Business do iPhone.
2. Copie `.env.example` para `.env`.
3. Copie `allowed-numbers.example.json` para `allowed-numbers.json` e coloque os números autorizados em `numbers`, como texto no formato país + DDD + número (somente dígitos). Reinicie o bot após editar essa lista. A lista real é privada e ignorada pelo Git; não a inclua na imagem Docker.
4. Em um terminal interativo local, execute:

```sh
PAIRING_MODE=true npm run dev
```

5. No aplicativo da **conta do bot**, abra Configurações → Aparelhos conectados → Conectar aparelho e escaneie o QR do terminal.
6. Envie uma foto do seu número pessoal para o bot, com a legenda `!figurinha`.
7. Nos próximos usos: `npm run build` e `npm start`. A sessão será reutilizada.

QR é credencial temporária: não compartilhe captura nem publique logs de vinculação. O programa exige terminal interativo para exibi-lo. Sem número autorizado, a inicialização falha antes de conectar.

Se não houver resposta: confirme a legenda, número autorizado, conexão e formato da imagem. Mensagens com identificador LID só são aceitas quando o WhatsApp fornece também o número alternativo correspondente; ausência desse mapeamento é bloqueada por segurança.

## Comportamento e limites

- Apenas conversas privadas dos números autorizados; ignora grupos, status, mensagens próprias, histórico, visualização única e imagens sem comando.
- No máximo três trabalhos pendentes; intervalo mínimo de dois segundos. Excedentes são ignorados. Uma conversão por vez.
- Downloads limitados a 10 MB reais e timeout de rede de 30 segundos.
- Deduplicação em memória por dez minutos; não persiste entre reinícios.
- Imagens processadas em memória; não arquiva fotos nem conversas.
- Logs não incluem texto, telefone ou credenciais da biblioteca.
- Reconexão com espera crescente; logout/conexão substituída exige revisão humana.

## Sessão e hospedagem

`data/auth/` contém **credenciais de acesso à conta**. Está fora do Git e da imagem Docker. Mantenha uma única instância e volume persistente. Nunca publique esses arquivos no GitHub.

Este MVP usa `useMultiFileAuthState`. O próprio Baileys **não o recomenda para produção**. Antes de operação contínua confiável, substituir por armazenamento transacional de credenciais e chaves, com testes de recuperação. O Docker abaixo serve para experimentação controlada; a imagem não foi validada em hospedagem.

```sh
# Após preparar .env:
docker compose build
# Vinculação dentro do volume Docker, em terminal privado:
docker compose run --rm -e PAIRING_MODE=true bot
# Depois de vincular e ver "Bot conectado", Ctrl+C; em seguida:
docker compose up -d
```

O volume do Docker é independente de `data/auth` da execução local. Portanto, usar Docker pela primeira vez requer a vinculação dentro do container. Não rode a mesma conta em duas instâncias do bot simultaneamente. Desligar o processo preserva a sessão; sair da conta no WhatsApp invalida a sessão.

Veja [a pesquisa de linguagem e hospedagem](docs/decisoes.md).

## Estrutura do projeto

| Arquivo | Responsabilidade |
|---|---|
| `src/main.ts` | Ponto de entrada, conexão e processamento de mensagens |
| `src/sticker.ts` | Conversão de imagens em figurinhas |
| `src/request.ts` | Regras de autorização e leitura limitada |
| `src/cli.ts` | Ferramenta de linha de comando sem WhatsApp |
| `test/sticker.test.ts` | Testes automatizados com o runner nativo do Node |

## Repositório

Código: [FelipePalombo/r-daneel-whatsapp](https://github.com/FelipePalombo/r-daneel-whatsapp).
`.env`, lista real de números, sessão, ferramentas locais, dependências e compilados
estão ignorados pelo Git. Copie os arquivos de exemplo para preparar outra instalação.
Não há licença escolhida para distribuição como projeto open source.

## Adicionar pessoas autorizadas

Edite `allowed-numbers.json` na raiz. Cada número deve ser uma string, com código do país (55 para Brasil), DDD e número, sem espaços ou sinais. Exemplo com números fictícios:

```json
{
  "numbers": [
    "5511999999999",
    "5521988888888"
  ]
}
```

Salve, pare o processo com Ctrl+C e execute `npm start`. Não é necessário compilar ou vincular novamente. Arquivo ausente, JSON inválido ou lista vazia impedem a inicialização; não existe liberação geral como fallback. A equivalência do nono dígito brasileiro é aplicada a cada número da lista.

No Docker Compose a lista é montada como arquivo somente leitura. Em outras hospedagens, forneça o mesmo arquivo em `/app/allowed-numbers.json` fora da imagem.

## Vídeos do Twitter/X e Instagram

Envie **somente o link da publicação**, ou `!video https://x.com/usuario/status/123`.
Também aceita links do Instagram nos formatos `/reel/codigo/`, `/reels/codigo/`, `/p/codigo/` e `/tv/codigo/`, sozinhos ou com `!video`. Não aceita Stories ou links de perfil.
O bot devolve o primeiro item se ele for vídeo, como MP4, com o link de origem na legenda. Em carrosséis que começam com foto, o download pode falhar.
Somente publicações públicas acessíveis sem login, até 3 minutos e 16 MiB.
Não acessa contas privadas, não usa cookies e não baixa transmissões ao vivo.
Uma publicação sem vídeo, que exija login ou bloqueada pelo Instagram/X recebe mensagem de falha.
A tentativa com yt-dlp tem timeout de 110 segundos e usa a mesma fila das figurinhas.
Arquivos temporários são removidos após o envio ou falha; downloads em andamento
podem deixar temporários se o processo for encerrado à força.

Requer [yt-dlp](https://github.com/yt-dlp/yt-dlp). Neste Mac foi instalado isoladamente
em `.tools/yt-dlp-current`, ignorado pelo Git e detectado automaticamente. Para reproduzir:

```sh
python3.13 -m venv .tools/yt-dlp-current
.tools/yt-dlp-current/bin/pip install 'yt-dlp[default,curl-cffi]==2026.10.21'
npm run check
npm start
```

Também aceita `yt-dlp` no PATH ou caminho absoluto em `YT_DLP_PATH` no `.env`.
A imagem Docker inclui a dependência, mas o build Docker ainda não foi validado.
Mudanças do X podem exigir atualização deliberada do yt-dlp.
Não precisa de API paga. O downloader escolhe MP4 direto; `ffprobe` (pacote ffmpeg) valida duração e presença de vídeo no arquivo final.

Código: `src/video.ts`; testes de URLs, autorização, limites e limpeza em `test/video.test.ts`.

## Contingência com Cobalt local

O bot tenta primeiro yt-dlp; em falha de download usa `COBALT_API_URL` se configurado.
Falha ao enviar no WhatsApp não aciona novo download. As duas opções preservam o limite
final de 16 MiB e 180 segundos. Metadados sem duração são aceitos para download e
verificados no arquivo com ffprobe. O Cobalt tem timeout adicional de 60 segundos.

Neste Mac: yt-dlp 2026.10.21 com Python 3.13; Cobalt 11.7.1, revisão
`a636575b09de1fc55d9b8cd98cac88f5f2f16b42`, em `.tools/cobalt`.
Ambos baixaram o Reel `DejIhofCWYv` durante a validação de 26/10/2026.
Não foram usados cookies ou login. Isso não garante acesso a todo conteúdo do Instagram.

Para iniciar a contingência após reiniciar o Mac, abra outro terminal na pasta do projeto:

```sh
npm run cobalt
```

Mantenha esse terminal aberto. A API escuta somente em `127.0.0.1:9000`.
No terminal do bot, execute `npm start`. O `.env` local já contém
`COBALT_API_URL=http://127.0.0.1:9000/`. Apagar essa variável desativa a contingência.
Nunca aponte para uma instância pública sem autorização do operador.

Para reinstalar o Cobalt local (requer pnpm):

```sh
git clone https://github.com/imputnet/cobalt.git .tools/cobalt
git -C .tools/cobalt checkout a636575b09de1fc55d9b8cd98cac88f5f2f16b42
cd .tools/cobalt
pnpm install
# Caso pnpm bloqueie scripts de instalação, revise e aprove os necessários:
pnpm approve-builds
```

Docker: a imagem do bot inclui yt-dlp e ffprobe, mas não inclui Cobalt.
`127.0.0.1` dentro do container é o próprio container; para usar a instância do Mac,
configure `COBALT_API_URL=http://host.docker.internal:9000/` e ajuste a interface
na qual o Cobalt escuta. O fluxo Docker não foi validado nesta alteração.

Referências: [API Cobalt](https://github.com/imputnet/cobalt/blob/main/docs/api.md),
[execução local](https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md).
