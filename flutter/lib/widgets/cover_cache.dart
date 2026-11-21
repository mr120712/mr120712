import 'package:flutter/widgets.dart';

/// Larghezza in pixel FISICI a cui decodificare una copertina mostrata larga [logical] pixel logici.
///
/// Senza questo limite (`memCacheWidth` di CachedNetworkImage) un'immagine da 1000×1000 resta in
/// memoria a piena risoluzione anche in una miniatura da 48 px: su un telefono da 4 GB, una lista di
/// copertine così occupa decine di MB. Si fissa solo la larghezza, così le proporzioni restano
/// quelle dell'originale (fissare anche l'altezza deformerebbe l'immagine prima del ritaglio).
int coverCachePx(BuildContext context, double logical) =>
    (logical * MediaQuery.devicePixelRatioOf(context)).ceil().clamp(1, 4096);
