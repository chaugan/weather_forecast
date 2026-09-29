# Local test copy of the production environment (PHP 8.4 + Apache reading .htaccess, like LiteSpeed on the host).
FROM php:8.4-apache
RUN docker-php-ext-install pdo_mysql \
 && a2enmod rewrite headers \
 && cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
 && { echo 'max_execution_time = 30'; echo 'memory_limit = 512M'; echo 'expose_php = Off'; } > "$PHP_INI_DIR/conf.d/glett.ini" \
 && printf '<Directory /var/www/html>\n  AllowOverride All\n</Directory>\nServerTokens Prod\nServerSignature Off\n' > /etc/apache2/conf-available/glett.conf \
 && a2enconf glett
