using Npgsql;

namespace AIChatApi.Data;

public class DbConnectionFactory(string connectionString)
{
    public NpgsqlConnection Create()
    {
        var builder = new NpgsqlDataSourceBuilder(connectionString);
        builder.UseVector();
        return builder.Build().OpenConnection();
    }
}
