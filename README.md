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

O destino da conversão não pode existir (proteção contra sobrescrita). Aceita JPEG, PNG ou WebP estático até 10 MB e 25 milhões de pixels. Corrige orientação e remove metadados. Fotos verticais são achatadas para preencher 512×512, sem cortar conteúdo; fotos horizontais preservam a proporção e recebem bordas transparentes. Não remove o fundo original nem gera imagens com IA. Para vídeo/GIF, veja a seção de figurinhas animadas.

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

## Figurinhas animadas

Envie **vídeo ou GIF com a legenda `!figurinha`**. Os GIFs enviados pelo seletor
normal do WhatsApp chegam como vídeo MP4 e também são aceitos. GIF enviado como
arquivo com MIME `image/gif` é aceito com a mesma legenda.

- Entrada: MP4/WebM ou GIF, até **10 MiB**, duração entre **0,2 e 10 segundos** e até 8.294.400 pixels por quadro.
- Trechos acima de 10 segundos são recusados com orientação para recortar; não há corte silencioso.
- Saída: WebP animado em loop, **512×512**, sem áudio e até **500.000 bytes**.
- Valida duração real informada pelo ffprobe antes de converter e estrutura/tamanho/duração
  de cada quadro do WebP final. Exige ao menos dois quadros e duração total de até 10 segundos.
- Tenta sete níveis de compressão, preservando a melhor qualidade que couber: reduz qualidade,
  taxa de quadros de 12 até 2 fps e resolução interna de 512 até 64 pixels. O canvas final
  permanece 512×512 e o trecho não é cortado. Em vídeos muito curtos, mantém quadros suficientes
  para a animação. Se ainda não couber, pede um trecho mais curto. Figurinhas não preservam áudio.
- Usa uma conversão por vez, uma thread de ffmpeg e timeout de 30 segundos por tentativa.
  Arquivos temporários são apagados também após falhas. A VM pequena pode demorar.
- Fotos mantêm a conversão estática. Mídia de visualização única continua bloqueada.

Os testes de animação exigem ffmpeg e ffprobe (`brew install ffmpeg` no Mac).
A imagem Docker já contém os dois.

Referência: [requisitos oficiais do WhatsApp para figurinhas](https://github.com/WhatsApp/stickers/blob/main/Android/README.md)
(WebP 512×512, animação de até 10 segundos, até 500 KB, mínimo de 8 ms por quadro).

## Comandos e atalhos

- `!figurinha` / `!f`: legenda de foto, vídeo ou GIF para criar figurinha.
- `!video <link>` / `!v <link>`: baixar vídeo público do Instagram ou Twitter/X.
- `!vfigurinha <link>` / `!vf <link>`: baixar uma vez e enviar o vídeo completo seguido de figurinha animada.
- Link isolado continua retornando somente o vídeo. Comandos aceitam maiúsculas e espaços nas extremidades.
- No comando combinado, a figurinha usa os primeiros 10 segundos, com aviso quando houver recorte.
  O vídeo completo mantém os limites de 16 MiB e 3 minutos. O trecho é preparado localmente,
  sem áudio, e passa pela validação de entrada de 10 MiB e compressão progressiva até 500.000 bytes.
- O envio direto com `!figurinha`/`!f` continua recusando animações acima de 10 segundos.
- Uma falha na figurinha após enviar o vídeo é informada separadamente, sem baixar novamente.

Figurinhas animadas de vídeo/GIF (`!figurinha`/`!f` e `!vfigurinha`/`!vf`) preenchem todo o quadrado 512×512, redimensionando largura e altura independentemente, sem corte ou bordas adicionadas. Isso pode deformar as proporções. O vídeo enviado junto pelo comando combinado preserva o formato original.

## Figurinha de GIF/WebP por link

Use `!gifigurinha <link>` ou `!gf <link>` para baixar a animação original e receber
somente a figurinha. Aceita GIF e WebP animado por link direto HTTPS, inclusive
links de imagens do Discord; a extensão pode ser diferente do conteúdo real.
Não extrai páginas do Tenor/Giphy e não aceita AVIF ou arquivo estático.

Até 10 MiB de download, timeout total de 30 segundos e três redirecionamentos.
Somente endereços públicos; DNS é validado e fixado por conexão, inclusive nos redirects.
Até 300 quadros, 50 milhões de pixels decodificados e 8.294.400 pixels por quadro.
Usa os primeiros 10 segundos, com aviso se houver recorte. Preserva transparência,
preenche 512×512 sem bordas adicionadas e aplica a compressão progressiva até 500.000 bytes.
Sharp normaliza os quadros em temporários e FFmpeg gera o WebP final; os arquivos
são removidos em sucesso ou falha. Links isolados e comandos anteriores não mudam.

Links de emotes `https://cdn.7tv.app/emote/<id>/4x.avif` (também 1x–3x) são aceitos por `!gf`/`!gifigurinha`: o bot busca automaticamente a versão `.webp` do mesmo emote. AVIF de outros serviços continua fora do suporte.

`!help` mostra a lista de comandos e aliases, exemplos de uso e limites. Disponível somente para números autorizados em conversa privada; usa a mesma fila e proteção contra pedidos repetidos. O texto fica em `src/help.ts`.

`!gf` e `!gifigurinha` também são aceitos como legenda de vídeo/GIF anexado no WhatsApp, incluindo GIFs do seletor GIPHY recebidos como MP4. Anexos mantêm os limites de 10 MiB e 0,2–10 segundos, sem recorte automático. O bot confirma o início antes de baixar/processar o anexo; pedidos por link também têm confirmação de início. Fotos comuns continuam usando `!f`/`!figurinha`.

Comandos iniciados por `!` que não existem recebem orientação para `!help`; comandos conhecidos com formato incorreto recebem instrução de uso específica. Vale para texto e legendas, após autorização, com a mesma fila e deduplicação. Texto comum e mídia de visualização única continuam ignorados. Links válidos em legendas seguem o mesmo processamento dos links em texto.

## Álbuns de fotos

Selecione até 10 fotos e envie `!f`/`!figurinha` na primeira foto do álbum; a legenda
pode chegar em qualquer membro. Associação explícita `MEDIA_ALBUM` vincula fotos
à conversa autorizada. Nunca herdar comandos por proximidade de horário.
O coletor espera os itens anunciados ou, sem contagem, 3 segundos de silêncio,
com prazo máximo de 15 segundos. Guarda no máximo dez referências às fotos;
rejeita visualização única e preserva autorização e deduplicação.
O lote ocupa uma das três vagas globais desde a coleta até o fim do processamento;
fotos são baixadas e convertidas uma por vez, com limites individuais existentes.
Falha em uma imagem não impede as demais. Lotes maiores processam as primeiras
dez, com aviso; mistos convertem só fotos. Lotes incompletos processam o recebido,
com aviso. Álbuns sem comando são descartados sem conversão.
Sem metadados de álbum, cada foto precisa de sua própria legenda; essas fotos
não têm o intervalo de 2 segundos, mas continuam sujeitas à fila de três pedidos.
Fila cheia gera aviso para aguardar e reenviar. `src/photo-batch.ts` trata a coleta
limitada e o envio sequencial; `src/job-queue.ts` compartilha reservas entre lotes
em coleta, tarefas aguardando e a tarefa em execução. Sessão continua única.
