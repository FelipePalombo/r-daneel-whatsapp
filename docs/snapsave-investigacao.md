# Investigação SnapSave — 30/10/2026

## Resultado

Viável como candidato adicional para Instagram. Um experimento isolado em Node.js,
na mesma imagem usada pelo bot na Oracle, consultou o endpoint, extraiu o endereço
e baixou dois Reels. ffprobe confirmou vídeo, áudio e duração dentro dos limites:

| Reel público | Bytes | Duração |
|---|---:|---:|
| `DfDImVNpqFn` | 1.353.556 | 11,121 s |
| `DfE2Cq5ovw6` | 3.172.532 | 18,018 s |

Não foi iniciada sessão WhatsApp no teste, nem enviada mensagem. Os arquivos
ficaram em diretório temporário do container e foram removidos. Nenhum cookie
pessoal, login, CAPTCHA ou execução de JavaScript recebido foi usado.

**SnapSave ainda não está integrado nem habilitado em produção.** As contingências
FxTwitter e VxTwitter foram implementadas, testadas e publicadas antes desta pesquisa.

## Chamada observada

A [página do downloader](https://snapsave.app/download-video-instagram) declara
um formulário POST para `https://snapsave.app/action.php`, com o campo `url`.
No experimento, o corpo foi `application/x-www-form-urlencoded`, com User-Agent
de navegador, Referer da página e Content-Length calculado em bytes. Esses cabeçalhos
funcionaram no teste; não foi demonstrado que todos sejam obrigatórios.

A resposta é um envelope de dados codificado em uma expressão JavaScript. O teste
somente decodificou o envelope, leu a string literal HTML e extraiu o link. Não usou
`eval`, DOM executável ou navegador. Consultas e transferências reutilizaram
`publicHttp`, com HTTPS público, DNS validado e IP fixado, limite textual de 1 MiB,
limite de mídia de 16 MiB e prazo total de 60 segundos por teste.

## Por que o parser atual não funcionava

O extrator do Snapinsta procura a atribuição à propriedade `innerHTML` do elemento
`download`. O SnapSave observado atribui o resultado ao elemento **`download-section`**.
O mesmo envelope é decodificável, mas o seletor esperado não corresponde à resposta.

Com leitura explícita do alvo `download-section`, a string HTML continha o endereço
de mídia `https://d.rapidcdn.app/v2?...`. As URLs assinadas e seus parâmetros não
foram registrados. O caminho e as assinaturas podem mudar.

## Implicações para uma futura integração

- Adicionar adaptador próprio; compartilhar a decodificação segura do envelope sem
  ampliar o parser para aceitar e executar código arbitrário.
- Manter alvos HTML conhecidos, allowlist de hosts, validação de cada redirect e DNS,
  limites de texto/mídia, ffprobe e limpeza.
- Usar depois do Snapinsta, dentro do mesmo orçamento adicional de 60 segundos;
  reservar tempo para o segundo provedor em vez de conceder um minuto a cada um.
- Preservar aviso único e ausência de novos downloads após falha de envio.
- Testar respostas de erro/HTML sem vídeo, mudanças de envelope, CAPTCHA, timeout,
  excesso de tamanho e mídia inválida com fixtures sintéticas.
- Ambos os Reels vieram de **`d.rapidcdn.app`**, CDN também observado no Snapinsta.
  Trata-se de outro ponto de consulta, sem comprovação de infraestrutura independente.
  Uma falha do CDN pode afetar os dois.

A biblioteca independente [snapsave-parser](https://github.com/Desiders/snapsave-parser)
também descreve o fluxo por `action.php`; não foi instalada nem executada. As
conclusões acima vêm das chamadas e validações isoladas realizadas na Oracle.
